// Dashboard logo: bare Helm compass-H mark (no tile) + per-theme mark colours with strong contrast on the rail.
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
  assert.match(CSS, /\[data-hb-theme="graphite"\] \{ --hb-mark2: var\(--hb-mark\)/);   // graphite = single-ink mark
  assert.match(CSS, /\.helm-mark \{[^}]*color: var\(--hb-mark\); fill: var\(--hb-mark2\); stroke: var\(--hb-mark2\)/);
});
t('mark.svg is the compass-H and stays theme-aware (currentColor H + inherited accent points)', () => {
  assert.match(MARK, /<symbol id="helm-mark" viewBox="0 0 48 48">/);
  assert.match(MARK, /<g fill="currentColor" stroke="none"><rect x="13" y="12"[^>]*\/><rect x="28\.5" y="12"/);   // the H
  const pts = MARK.match(/<g stroke-width="0\.9" stroke-linejoin="round">(.*?)<\/g>/);
  assert.ok(pts, 'compass points group'); assert.doesNotMatch(pts[0], /fill=|stroke="/);   // inherit fill+stroke from host
  assert.equal((pts[1].match(/<path /g) || []).length, 3);
  assert.doesNotMatch(MARK, /#0[0-9A-F]{5}"[^>]*\/>\s*<\/symbol>/i);   // no fixed brand blues inside the symbol
  const MONO = read('public/brand/mark-mono.svg'); assert.match(MONO, /fill="currentColor"/); assert.doesNotMatch(MONO, /#[0-9a-f]{6}/i);
  for (const f of ['public/brand/mark-ink.svg', 'public/brand/mark-acc.svg', 'public/brand/favicon.svg', 'public/favicon.svg']) assert.ok(read(f).includes('<svg'), f);
  for (const f of ['public/home.css', 'public/legal.css']) assert.match(read(f), /\.mark i\+i\{background:var\(--acc\);-webkit-mask-image:url\(\/brand\/mark-acc\.svg\)/, f);
});
t('every theme pill colour has >= 4.5:1 contrast on its rail background', () => {
  // [theme, rail bg, pill1 (ink), pill2 (accent text / graphite ink3)] — values copied from the token blocks
  const rows = [
    ['cobalt light', '#ffffff', '#0b1b3f', '#1d44d8'], ['cobalt dark', '#111833', '#e8edfb', '#93acff'], ['os-dark fallback', '#121212', '#f2f2f2', '#93acff'],
    ['emerald light', '#ffffff', '#0b2a22', '#036b4d'], ['emerald dark', '#0f1f1c', '#e6f4ef', '#5fe0b0'],
    ['midnight light', '#ffffff', '#12133a', '#3f34c2'], ['midnight dark', '#14152f', '#ebebfa', '#a9a4ff'],
    ['graphite light', '#ffffff', '#111111', '#111111'], ['graphite dark', '#161616', '#f2f2f2', '#f2f2f2'],
    ['studio light', '#faf8f5', '#1f1a24', '#5b2a86'], ['studio dark', '#141216', '#f3f0f5', '#b794e0'],
    ['luxe light', '#f7f3ea', '#1b1814', '#6b1e24'], ['luxe dark', '#14120f', '#efe8db', '#d29a96'],
  ];
  for (const [name, bg, a, b] of rows) {
    assert.ok(ratio(a, bg) >= 7, name + ' ink ' + ratio(a, bg).toFixed(2));
    assert.ok(ratio(b, bg) >= 4.5, name + ' points ' + ratio(b, bg).toFixed(2));
  }
  for (const v of ['#1d44d8', '#93acff', '#036b4d', '#5fe0b0', '#3f34c2', '#a9a4ff']) assert.ok(CSS.toLowerCase().includes(v), v);
});
console.log(n + ' tests passed');
