// Brand kit logo (docs/HELM_Brand_and_Website_Kit 2, copied as-is): rail = kit symbol + "ELM" (HELM lockup),
// collapsed rail = symbol only; graphite = monochrome; dark = on-dark. Marketing/login use the kit HELM lockup.
import { readFileSync, existsSync } from 'node:fs';
import assert from 'node:assert/strict';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const KIT = 'docs/HELM_Brand_and_Website_Kit 2/HELM_Brand_Kit/assets/svg/';
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok -', name); };
t('kit SVGs are copied byte-for-byte into public/brand', () => {
  for (const f of ['helm-primary', 'helm-on-dark', 'helm-monochrome', 'helm-symbol', 'helm-symbol-on-dark', 'helm-symbol-mono', 'helm-app-icon']) {
    if (existsSync(new URL('../' + KIT + f + '.svg', import.meta.url))) assert.equal(read('public/brand/' + f + '.svg'), read(KIT + f + '.svg'), f);
    else assert.match(read('public/brand/' + f + '.svg'), /^<svg /);
  }
  assert.equal(read('public/favicon.svg'), read('public/brand/favicon.svg')); assert.ok(read('public/favicon.svg').includes('M148 153 H232'));
  for (const v of ['', '-on-dark', '-monochrome']) assert.match(read('public/brand/helm-elm' + v + '.svg'), /viewBox="512 -3 1004 645"/);
});
t('app rail = kit shape (symbol + ELM) recoloured per theme via CSS variables', () => {
  const JS = read('public/shell-b.js'), CSS = read('public/shell-b.css');
  assert.match(JS, /"class": "hl-ink", d: HL\.h/); assert.match(JS, /"class": "hl-acc"/); assert.match(JS, /el\("span", "hb-lb hb-name"\)/);
  assert.ok(JS.includes('M148 153 H232 V284 H386 V153 H475 V486'), 'kit H geometry');
  assert.match(CSS, /\.hl-ink \{ fill: var\(--hl-ink\); \}/);
  for (const [th, ink, acc] of [['cobalt', '#1d3fcf', '#38bdf8'], ['midnight', '#3730a3', '#a78bfa'], ['graphite', '#111111', '#111111'], ['studio', '#5b2a86', '#d4a24c']])
    assert.ok(CSS.includes(`[data-hb-theme="${th}"] { --hl-ink: ${ink}; --hl-acc: ${acc};`), th);
  assert.ok(CSS.includes('--hl-ink: #0b5d44; --hl-acc: #2fcf98;'), 'emerald');
});
t('login + marketing use the inline themeable HELM lockup', () => {
  for (const f of ['public/login.html', 'public/index.html']) assert.match(read(f), /<svg class="lockup hl-logo" viewBox="-14 -10 1530 660"/, f);
  assert.match(read('public/home.css'), /\.hl-acc\{fill:#2fcf98/);
});
console.log(n + ' tests passed');
