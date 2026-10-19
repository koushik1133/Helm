// r20 coord (e) (owner decision 2026-10-18): the user manual is hidden for now.
// ONE flag - config.js window.HELM_FEATURES.manual (false) - and every entry point checks it:
// profile menu item, Control Center Help link, search catalog page, both tour texts (dashboard + shell),
// and /manual itself, which shows "The user manual is coming soon." with NO storage fetch while off.
// The manual code + docs/manual stay so flipping the flag to true brings everything back.
// Static source checks + pure helpers run in a vm. No network, no DB.
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import vm from 'node:vm';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const tests = []; const t = (n, f) => tests.push([n, f]);
const CFG = read('public/config.js'), AUI = read('public/auth-ui.js'), SHB = read('public/shell-b.js');
const CS = read('public/control-split.js'), CAT = read('public/search-catalog.js'), DASH = read('public/dashboard.html');
const MJS = read('public/manual.js'), MHTML = read('public/manual.html');
const FLAG = /window\.HELM_FEATURES && window\.HELM_FEATURES\.manual ?=== ?true/;
const fnSrc = (src, name) => { const s = src.indexOf('function ' + name + '('); assert.ok(s >= 0, name); let i = src.indexOf('{', s), d = 0;
  for (; i < src.length; i++) { if (src[i] === '{') d++; else if (src[i] === '}' && --d === 0) break; } return src.slice(s, i + 1); };

t('1 one flag in config.js: HELM_FEATURES.manual is false (evaluated)', () => {
  const ctx = { window: {}, location: { hostname: 'helm.events' } };
  vm.runInNewContext(CFG, ctx);
  assert.equal(ctx.window.HELM_FEATURES.manual, false);
  assert.equal((CFG.match(/manual: false/g) || []).length, 1, 'declared once');
});

t('2 profile menu: no "User manual" while off; back when the flag is true', () => {
  const ctx = { S: () => ({ auth: { admin: { roleLabel: (r) => r } } }) };
  vm.runInNewContext('var AV_COLORS = 8;\n' + ['initials', 'avColorIdx', 'menuModel'].map((f) => fnSrc(AUI, f)).join('\n') + '\nglobalThis.mm=menuModel;', ctx);
  const ids = () => ctx.mm({ id: 'u', email: 'a@b.test' }, {}, 'admin').items.map((i) => i.id).join(',');
  assert.equal(ids(), 'profile,settings,signout', 'no window / no flag = hidden');
  ctx.window = { HELM_FEATURES: { manual: false } }; assert.equal(ids(), 'profile,settings,signout');
  ctx.window = { HELM_FEATURES: { manual: true } }; assert.equal(ids(), 'profile,settings,manual,signout');
  assert.match(fnSrc(AUI, 'menuModel'), /window\.HELM_FEATURES\.manual === true\)\n\s+items\.push\(\{ id: "manual"/);
});

t('3 Control Center Help -> User manual is only added behind the flag', () => {
  assert.match(CS, /if\(window\.HELM_FEATURES && window\.HELM_FEATURES\.manual===true\) aside\.appendChild\(help\);/);
  assert.equal((CS.match(/aside\.appendChild\(help\)/g) || []).length, 1, 'no ungated append');
  assert.doesNotMatch(read('public/control.html'), /manual\.html/i, 'no hard-coded link in control.html');
});

t('4 search catalog: the manual page is behind { feature: "manual" } (hidden while off, back when on)', async () => {
  assert.match(CAT, /\{ key: "manual",\s+label: "User manual",\s+href: "manual\.html",\s+gate: \{ feature: "manual" \}/);
  const C = (await import(new URL('../public/search-catalog.js', import.meta.url))).default;
  const a = { role: async () => 'admin', canView: async () => true };
  const keys = async (f) => (await C.entriesFor(a, f)).filter((e) => e.kind === 'page').map((e) => e.key);
  assert.ok(!(await keys({})).includes('manual'));
  assert.ok(!(await keys({ manual: false })).includes('manual'));
  assert.ok((await keys({ manual: true })).includes('manual'));
});

t('5 tour texts mention the manual only while it is on (dashboard + shell tour)', () => {
  assert.match(DASH, /get desc\(\)\{ return \(window\.HELM_FEATURES&&window\.HELM_FEATURES\.manual===true\)\?"Your account, settings, the user manual and sign out live here\.":"Your account, settings and sign out live here\."; \}\}/);
  assert.match(SHB, /desc: \(window\.HELM_FEATURES && window\.HELM_FEATURES\.manual === true\) \? "[^"]*the user manual and sign out\." : "Your profile, account settings \(password and two-step verification\) and sign out\." \}/);
  // no other ungated "user manual" wording in the tours or the keyboard-shortcuts sheet
  for (const [name, src] of [['tour.js', read('public/tour.js')], ['shortcuts sheet', fnSrc(SHB, 'helpGroups')]])
    assert.doesNotMatch(src, /user manual|manual\.html/i, name);
  assert.equal((DASH.match(/the user manual/g) || []).length, 1);
  assert.equal((SHB.match(/the user manual/g) || []).length, 1);
});

t('6 every app link to manual.html is gated (no stray entry point)', () => {
  // (control-split.js builds its Help link up front and only appends it behind the flag - checked in 3)
  const files = ['public/auth-ui.js', 'public/shell-b.js', 'public/search-catalog.js', 'public/dashboard.html',
    'public/studio-search.js', 'public/tour.js', 'public/shell-b-dash.js', 'public/control.html'];
  for (const f of files) {
    const src = read(f);
    for (const m of src.matchAll(/manual\.html/g)) {
      const near = src.slice(Math.max(0, m.index - 900), m.index + 60);
      assert.ok(FLAG.test(near) || /manual===true/.test(near) || /feature: "manual"/.test(near), f + ' has an ungated manual.html link');
    }
  }
});

t('7 /manual: "coming soon", no sign-in round trip and NO storage fetch while off (vm)', async () => {
  assert.match(MJS, /function manualEnabled\(\) \{ return !!\(window\.HELM_FEATURES && window\.HELM_FEATURES\.manual === true\); \}/);
  assert.match(fnSrc(MJS, 'boot'), /^function boot\(\) \{\n\s+if \(!manualEnabled\(\)\) \{ comingSoon\(\); return; \}/);
  assert.match(MJS, /state\("The user manual is coming soon\."/);
  const calls = [];
  const mk = () => ({ hidden: false, firstChild: null, children: [], appendChild(c) { this.children.push(c); return c; }, removeChild() {} });
  const box = mk(), docEl = mk();
  const document = { readyState: 'complete', querySelector: (s) => (s === '#mState' ? box : docEl),
    createElement: (tag) => ({ tag, textContent: '', href: '' }) };
  const BPStore = new Proxy({}, { get: (_, k) => { calls.push(k); return new Proxy(() => Promise.resolve(), { get: (_, kk) => { calls.push(k + '.' + kk); return () => Promise.resolve(); } }); } });
  const ctx = { window: { HELM_FEATURES: { manual: false } }, document, BPStore, location: { replace: (u) => calls.push('redirect ' + u), hash: '' },
    fetch: (...a) => { calls.push('fetch'); return Promise.reject(new Error('no')); }, DOMParser: function () {} };
  vm.runInNewContext(MJS, ctx);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(calls, [], 'no BPStore / storage / fetch / redirect while the manual is off');
  assert.equal(box.children[0].textContent, 'The user manual is coming soon.');
  assert.equal(box.children[2].href, 'dashboard');
  // the page keeps its shell (theme, styling, status box) and loads no manual content
  assert.match(MHTML, /<div id="mState" class="mstate" role="status" aria-live="polite">/);
  assert.match(MHTML, /public-pages-v2\.css/);
  assert.match(MHTML, /config\.js\?v=\d+"><\/script>[\s\S]*manual\.js\?v=\d+/, 'config.js (the flag) loads before manual.js');
});

t('8 nothing deleted: manual code + source stay for re-enabling', () => {
  assert.match(MJS, /BPStore\.manual\.load\(3600\)/);
  assert.match(read('public/store-api.js'), /storage\.from\("helm-manual"\)/);
  assert.ok(existsSync(new URL('../docs/manual/USER-MANUAL.html', import.meta.url)));
});

let n = 0;
for (const [name, fn] of tests) { await fn(); n++; console.log('ok -', name); }
console.log(`\nr20-coord-e: ${n} passed`);
