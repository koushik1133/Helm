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
  assert.equal(read('public/favicon.svg'), read('public/brand/helm-app-icon.svg'));
  for (const v of ['', '-on-dark', '-monochrome']) assert.match(read('public/brand/helm-elm' + v + '.svg'), /viewBox="512 -3 1004 645"/);
});
t('app rail = kit symbol + ELM, one variant per theme', () => {
  const JS = read('public/shell-b.js'), CSS = read('public/shell-b.css');
  for (const f of ['helm-symbol.svg', 'helm-symbol-on-dark.svg', 'helm-symbol-mono.svg', 'helm-elm.svg', 'helm-elm-on-dark.svg', 'helm-elm-monochrome.svg']) assert.ok(JS.includes('/brand/' + f), f);
  assert.match(JS, /el\("span", "hb-lb hb-name"\)/);   // ELM hides with the label when the rail is collapsed
  assert.match(CSS, /\[data-hb-theme="graphite"\] \.hb-k-mono \{ display: block !important; \}/);
  assert.match(CSS, /\[data-theme="dark"\]:not\(\[data-hb-theme="graphite"\]\) \.hb-k-dark/);
  assert.doesNotMatch(JS, /mark\.svg/);
});
t('login + marketing use the kit HELM lockup', () => {
  assert.match(read('public/login.html'), /<img class="lockup" src="\/brand\/helm-primary\.svg\?v=1" alt="Helm"/);
  assert.match(read('public/index.html'), /<img class="lockup" src="\/brand\/helm-primary\.svg\?v=1" alt="Helm"/);
  assert.doesNotMatch(read('public/index.html'), /<span class="mark" aria-hidden="true"><i><\/i><i><\/i><\/span>Helm/);
});
console.log(n + ' tests passed');
