// R98 (owner): Midnight is parked (not selectable; a saved midnight silently falls back to emerald; its CSS is kept for a
// later restore), the split "New quote" buttons (top bar + dashboard hero) are ONE pill in every theme, and contrast fixes.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const r = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0; const t = (name, fn) => { try { fn(); n++; } catch (e) { console.error('FAIL', name); throw e; } };

function runPublic(store) {
  const attrs = {};
  const root = { style: {}, classList: { add() {}, remove() {} }, getAttribute: (k) => (k in attrs ? attrs[k] : null), setAttribute: (k, v) => { attrs[k] = String(v); } };
  const win = { localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } }, matchMedia: () => ({ matches: false }) };
  win.window = win; win.document = { documentElement: root, readyState: 'complete', querySelectorAll: () => [] };
  win.MutationObserver = function () { this.observe = () => {}; };
  vm.runInNewContext(r('public/public-theme.js'), win); return { attrs, store };
}
const LIVE = ['emerald', 'cobalt', 'graphite', 'studio'];

t('midnight is not selectable: not in the picker, the demo select, the search keywords or any allow-list', () => {
  const shell = r('public/shell-b.js');
  assert.ok(!/\["midnight"/.test(shell), 'picker list'); assert.ok(!/Midnight/.test(shell), 'tour text');
  for (const th of LIVE) assert.ok(shell.includes(`["${th}", `), th + ' still in the picker');
  assert.ok(!/value="midnight"/.test(r('public/demo.html')), 'demo select');
  assert.ok(!/midnight/.test(r('public/search-catalog.js').split('\n').find((l) => l.includes('id: "theme"'))), 'search keywords');
  assert.match(r('public/shell-proto.js'), /\/\^\(cobalt\|emerald\|graphite\|studio\)\$\//);
  assert.ok(!/midnight: 1/.test(r('public/public-theme.js')));
});
t('a saved midnight maps to emerald (and the stored value is left alone)', () => {
  const s = runPublic({ 'helm.shellb.theme': 'midnight', 'helm.theme.v': '2' });
  assert.equal(s.attrs['data-hb-theme'], 'emerald'); assert.equal(s.attrs['data-pt'], 'emerald');
  assert.equal(s.store['helm.shellb.theme'], 'midnight', 'user data is not deleted or rewritten');
  for (const th of LIVE) assert.equal(runPublic({ 'helm.shellb.theme': th, 'helm.theme.v': '2' }).attrs['data-hb-theme'], th);
  // the app shell (head script) uses the same allow-list -> anything else falls back to emerald
  const line = r('public/shell-proto.js').split('\n').find((l) => l.includes('setAttribute("data-hb-theme"'));
  assert.match(line, /\? th : "emerald"/);
});
t('midnight CSS is kept but parked with a restore note', () => {
  for (const f of ['public/shell-b.css', 'public/shell-b-style.css', 'public/builder-v2.css', 'public/public-v2.css', 'public/public-pages-v2.css', 'public/demo.css']) {
    const c = r(f); assert.ok(c.includes('midnight'), f + ' keeps the rules'); assert.ok(c.includes('parked R98, owner may restore'), f + ' comment');
  }
});
t('split-button styles: one pill in every theme (top bar + hero)', () => {
  const css = r('public/shell-b.css'), dash = r('public/shell-b-dash.css');
  // theme-agnostic selectors outrank per-theme ".hb-new" overrides (e.g. studio's border-radius) for EVERY data-hb-theme
  assert.match(css, /\[data-hb-theme\] \.hb-split > \.hb-new \{ background: var\(--hb-acc\);[^}]*box-shadow: none; transform: none;/);
  assert.match(css, /\[data-hb-theme\] \.hb-split > \.hb-new:not\(\.hb-chev\):not\(:last-of-type\) \{ border-radius: 10px 0 0 10px; \}/);
  assert.match(css, /\[data-hb-theme\] \.hb-split > \.hb-chev:not\(\.hb-solo\) \{ border-radius: 0 10px 10px 0; border-left: 1px solid color-mix\(in srgb, var\(--hb-acc-ink\) 32%, transparent\)/);
  assert.match(css, /\[data-hb-theme\] \.hb-split > \.hb-new:hover/); assert.match(css, /\[data-hb-theme\] \.hb-split > \.hb-new:focus-visible \{ outline: 2px solid var\(--hb-acc-ink\); outline-offset: -4px;/);
  assert.match(dash, /\.hd-split > #createBtn:not\(\[hidden\]\) \{ border-radius: 10px 0 0 10px; \}/);
  assert.match(dash, /\.hd-split > \.hd-btn\.hd-split-tog \{ border-radius: 0 10px 10px 0; border-left: 1px solid/);
  assert.match(dash, /\.hd-split > \.hd-btn\.hd-primary \{ background: var\(--hd-acc\);[^}]*box-shadow: none; filter: none; transform: none;/);
  // each live theme defines the tokens the split uses
  assert.match(css, /html\[data-shell="b"\] \{ --hb-bg: #ffffff;[^}]*--hb-acc: #2450f0;[^}]*--hb-acc-ink: #ffffff;/);
  for (const th of ['emerald', 'graphite']) assert.match(css, new RegExp(`\\[data-hb-theme="${th}"\\] \\{[^}]*--hb-acc: #[0-9a-f]{6};[^}]*--hb-acc-ink: #ffffff;`));
  assert.match(r('public/shell-b-theme-studio.css'), /--hb-acc:var\(--c8-ac\);[^;]*; --hb-acc-ink:var\(--c8-aci\);/);
});
t('contrast: primary gradient top keeps white text >= 4.5:1; "View all" uses the accent text', () => {
  assert.match(r('public/shell-b.css'), /--hb-grad: linear-gradient\(180deg, color-mix\(in srgb, var\(--hb-acc\) 92%, #fff\)/);
  assert.match(r('public/shell-b-dash.css'), /\.hd-dash a\.hd-more-link \{[^}]*color: var\(--hd-acc-text\)/);
});
console.log(n + ' tests passed');
