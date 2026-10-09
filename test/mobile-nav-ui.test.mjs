// Mobile bottom bar: pure helpers + wiring guards (no inline style / innerHTML, CSS via
// __helmAdoptCss, loader skips HQ/public pages, role-gated create sheet).
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const SRC = read('public/mobile-nav.js');
const CODE = SRC.replace(/^\s*\/\/.*$/gm, '');
const STORE = read('public/store-api.js');
const ctx = { module: { exports: {} } }; ctx.globalThis = ctx; vm.createContext(ctx);
vm.runInContext(SRC, ctx);
const M = ctx.module.exports;
let n = 0; const t = (name, fn) => { fn(); n++; };

t('eligible', () => {
  assert.equal(M.eligible('dashboard', 'admin', '/dashboard.html'), true);
  for (const p of ['hq', 'login', 'portal', 'approve', 'index', 'work', 'invite']) assert.equal(M.eligible(p, 'admin', '/' + p + '.html'), false, p);
  assert.equal(M.eligible('dashboard', 'client', '/dashboard.html'), false);
  assert.equal(M.eligible('x', 'admin', '/i/some-slug'), false);
});
t('activeTab', () => { assert.equal(M.activeTab('dashboard'), 'home'); assert.equal(M.activeTab('leads'), ''); });
t('keyboardOpen', () => { assert.equal(M.keyboardOpen(800, 400), true); assert.equal(M.keyboardOpen(800, 780), false); assert.equal(M.keyboardOpen(800, undefined), false); });
await (async () => {
  const auth = { canEditArea: async (a) => a === 'leads', can: async () => false, canView: async () => true };
  const got = await M.allowedCreates(auth);
  assert.equal(got.map((x) => x.id).join(), 'new-lead');
  const all = await M.allowedCreates({ canEditArea: async () => true, can: async () => true, canView: async () => true });
  assert.equal(all.length, M.CREATES.length);
  const thrown = await M.allowedCreates({ canEditArea: async () => { throw new Error('x'); }, can: async () => true });
  assert.equal(thrown.length, 0);
  assert.equal((await M.allowedCreates(null)).length, 0);
  n++;
})();
t('hygiene', () => {
  assert.ok(!/innerHTML|insertAdjacentHTML|\.style\s*[.=]|setAttribute\(\s*["']style/.test(CODE));
  assert.ok(SRC.includes('__helmAdoptCss'));
  assert.ok(/safe-area-inset-bottom/.test(M._css) && /max-width:767\.98px/.test(M._css));
  M.CREATES.forEach((c) => assert.match(c.href, /^[a-z-]+\.html(\?hs_act=new)?$/));
});
function NAVSRC_FOR_TOUR() { return readFileSync(new URL('../public/mobile-nav.js', import.meta.url), 'utf8'); }
t('loader', () => {
  assert.match(STORE, /function loadMobileNav\(\)[\s\S]{0,300}NO_SEARCH_PAGES\[pageKey\(\)\] \|\| PUBLIC_PAGES\[pageKey\(\)\] \|\| publicLinkPath\(\)/);
  assert.match(STORE, /mobile-nav\.js\?v=/);
});
t('tour FAB sits above the bottom bar (never covers Profile) while the bar shows', () => {
  const tour = readFileSync(new URL('../public/tour.js', import.meta.url), 'utf8');
  const m = /@media \(max-width:767\.98px\)\{body\.hmn-on:not\(\.hmn-kb\) \.htour-fab\{bottom:calc\((\d+)px/.exec(tour);
  assert.ok(m, 'tour.js must lift .htour-fab when body.hmn-on');
  const bar = /\.hmn-bar\{[^}]*height:calc\((\d+)px/.exec(NAVSRC_FOR_TOUR());
  assert.ok(bar && Number(m[1]) >= Number(bar[1]) + 8, 'FAB bottom must clear the bar height');
  assert.match(NAVSRC_FOR_TOUR(), /@media \(max-width:767\.98px\)/, 'same breakpoint as the bar');
});
console.log(`mobile-nav-ui: ${n} checks passed`);
