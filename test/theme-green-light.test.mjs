// Theme Oct 2026: default colour theme = EMERALD (green) in LIGHT mode for every studio and new user,
// dark mode switched OFF everywhere behind one flag (window.HELM_DARK_MODE === true brings it back; dark CSS kept),
// graphite = pure black & white, and devices still on the old cobalt default move to emerald once.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const r = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0; const t = (name, fn) => { try { fn(); n++; } catch (e) { console.error('FAIL', name); throw e; } };

/* a tiny DOM: documentElement attributes + MutationObserver that fires synchronously */
function sandbox(store, extra = {}) {
  const attrs = {}, obs = [];
  const root = {
    style: {}, classList: { add() {}, remove() {} },
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    setAttribute: (k, v) => { const old = attrs[k]; attrs[k] = String(v); if (old !== attrs[k]) obs.forEach((f) => f()); },
  };
  const ls = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
  const win = { localStorage: ls, matchMedia: () => ({ matches: true }) /* OS says dark */, ...extra };
  win.window = win;
  win.document = { documentElement: root, readyState: 'complete', querySelectorAll: () => [] };
  win.MutationObserver = function (f) { this.observe = () => obs.push(f); };
  return { win, attrs, store };
}
const runPublic = (store, extra) => { const s = sandbox(store, extra); vm.runInNewContext(r('public/public-theme.js'), s.win); return s; };

t('public pages default to emerald + light, even when the OS prefers dark', () => {
  const s = runPublic({});
  assert.equal(s.attrs['data-hb-theme'], 'emerald'); assert.equal(s.attrs['data-pt'], 'emerald'); assert.equal(s.attrs['data-theme'], 'light');
  assert.equal(s.store['helm.theme.v'], '2');
});
t('a saved dark preference is ignored while dark mode is off', () => {
  const s = runPublic({ 'bps.theme': 'dark', 'helm.shellb.theme': 'graphite', 'helm.theme.v': '2' });
  assert.equal(s.attrs['data-theme'], 'light'); assert.equal(s.attrs['data-hb-theme'], 'graphite');
  assert.equal(s.store['bps.theme'], 'dark', 'the stored preference is kept (not deleted), just not applied');
});
t('light lock: a page-level toggle cannot switch to dark', () => {
  const s = runPublic({});
  s.win.document.documentElement.setAttribute('data-theme', 'dark');
  assert.equal(s.attrs['data-theme'], 'light');
});
t('old cobalt default migrates to emerald once; a later cobalt choice sticks', () => {
  const s = runPublic({ 'helm.shellb.theme': 'cobalt' });
  assert.equal(s.attrs['data-hb-theme'], 'emerald'); assert.equal(s.store['helm.shellb.theme'], 'emerald');
  const s2 = runPublic({ 'helm.shellb.theme': 'cobalt', 'helm.theme.v': '2' });
  assert.equal(s2.attrs['data-hb-theme'], 'cobalt');
  const s3 = runPublic({ 'helm.shellb.theme': 'midnight' });
  assert.equal(s3.attrs['data-hb-theme'], 'midnight', 'a deliberate non-default choice is never overwritten');
});
t('flag on brings dark back (saved preference, then OS)', () => {
  assert.equal(runPublic({ 'bps.theme': 'dark' }, { HELM_DARK_MODE: true }).attrs['data-theme'], 'dark');
  assert.equal(runPublic({}, { HELM_DARK_MODE: true }).attrs['data-theme'], 'dark');
});

const api = r('public/store-api.js'), proto = r('public/shell-proto.js'), shell = r('public/shell-b.js');
t('store-api: flag-gated light lock, no floating toggle while off', () => {
  const blk = api.slice(api.indexOf('/* Phase 54'), api.indexOf('/* ---- global "logo = home"'));
  assert.match(blk, /var DARK_ON = window\.HELM_DARK_MODE === true;/);
  assert.match(blk, /if \(!DARK_ON\) \{[\s\S]*?MutationObserver\(lock\)[\s\S]*?return;   \/\/ no floating toggle/);
  assert.ok(blk.indexOf('return;   // no floating toggle') < blk.indexOf('localStorage.getItem("bp_theme")'), 'bp_theme only read when dark is on');
});
t('shell-proto: emerald default + light before paint', () => {
  assert.match(proto, /\? th : "emerald"\);/);
  assert.ok(!/\? th : "cobalt"/.test(proto));
  assert.match(proto, /if \(window\.HELM_DARK_MODE !== true\) \{ root\.setAttribute\("data-theme", "light"\)/);
  assert.match(proto, /localStorage\.getItem\("helm\.theme\.v"\) !== "2"/);
});
t('shell-b rail: no dark toggle, colour theme picker as a rail item, emerald first', () => {
  assert.match(shell, /if \(DARK_ON\) adopt\(function \(\) \{ return document\.getElementById\("bpThemeToggle"\)/);
  assert.match(shell, /sw = el\("button", "hb-item hb-switem"\); sw\.id = "hbThemePick"/);
  assert.match(shell, /var TH = \[\["emerald", "Emerald"/);
  assert.match(shell, /\|\| "emerald"; \};/);
  const css = r('public/shell-b.css');
  assert.match(css, /\.hb-theme:not\(:has\(#bpThemeToggle, \.hb-switem\)\)/);
});
t('graphite is pure black and white', () => {
  const css = r('public/shell-b.css');
  const g = css.split('\n').find((l) => l.startsWith('html[data-shell="b"][data-hb-theme="graphite"] {'));
  assert.ok(g, 'graphite light tokens');
  assert.match(g, /--hb-acc: #000000/); assert.match(g, /--hb-ink: #000000/); assert.match(g, /--hb-bg: #ffffff/);
  for (const f of ['public/public-v2.css', 'public/public-pages-v2.css', 'public/builder-v2.css']) {
    const l = r(f).split('\n').find((x) => x.includes('graphite"]') && !x.includes('dark') && x.includes('--accent:'));
    assert.match(l, /--accent:#000000/, f);
    for (const hex of l.match(/#[0-9a-f]{6}/gi)) { const [a, b, c] = [1, 3, 5].map((i) => hex.slice(i, i + 2)); assert.ok(a === b && b === c, `${f}: ${hex} is a neutral grey`); }
  }
});
t('every page-level light/dark toggle is flag-gated', () => {
  assert.match(r('public/builder.js'), /if\(window\.HELM_DARK_MODE===true\) \$\('#themeBtn'\)\.addEventListener\('click',toggleTheme\); else/);
  assert.match(r('public/chat.html'), /if\(window\.HELM_DARK_MODE!==true\)\{ b\.hidden=true;/);
  assert.match(r('public/demo.js'), /mode && W\.HELM_DARK_MODE !== true/);
  for (const f of ['public/builder.html', 'public/capture.html']) assert.match(r(f), /window\.HELM_DARK_MODE === true \? localStorage\.getItem\('bps\.theme'\) : 'light'/);
  assert.match(r('public/try.js'), /window\.HELM_DARK_MODE === true \? localStorage\.getItem\('bps\.theme'\) : 'light'/);
  assert.match(r('public/shell-b-search.js'), /"Change colour theme"/);
  assert.ok(!/@media \(prefers-color-scheme:dark\)/.test(r('public/trial.js')), 'trial banners follow the app theme, not the OS');
});
t('dark CSS is kept (only never applied)', () => {
  assert.match(r('public/shell-b.css'), /\[data-theme="dark"\]\[data-hb-theme="graphite"\]/);
  assert.match(r('public/public-pages-v2.css'), /html\[data-pt="emerald"\]\[data-theme="dark"\]/);
});
t("Control Center search: soft iPad-style field, accent focus ring, highlighted matches, keyboard nav kept", () => {
  const c = r("public/control-split.css"), j = r("public/control-split.js");
  assert.match(c, /\.cs-search\{[^}]*-apple-system/);
  assert.match(c, /\.cs-search input:focus\{[^}]*color-mix\(in srgb,var\(--cs-acc\) 18%/);
  assert.match(c, /\.cs-results mark\{[^}]*background:color-mix/);
  assert.match(c, /border-radius:12px/);
  assert.match(j, /e\.key==="ArrowDown"/);
  assert.match(j, /role","combobox"/);
  assert.match(r("public/control.html"), /control-split\.css\?v=7/);
});
console.log(`theme-green-light: ${n} passed`);
