// staging-1026.test.mjs - staging QA fixes (Oct 2026, fix/staging-1026).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const r = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('ok -', name); };

function extractFn(src, startToken) {
  const i = src.indexOf(startToken); if (i < 0) throw new Error('not found: ' + startToken);
  const open = src.indexOf('{', i); let depth = 0, j = open;
  for (; j < src.length; j++) { const ch = src[j]; if (ch === '{') depth++; else if (ch === '}') { depth--; if (depth === 0) { j++; break; } } }
  return src.slice(open, j);
}
const STORE = r('public/store-api.js'), FLOW = r('public/flow.html');

await t('#1 advance default uses the discounted grand total (10% of 1,01,952 = 10,195)', () => {
  const canon = new Function('a', 'return ((a)=>' + extractFn(STORE, '_canon(a)') + ')(a)');
  const qt = new Function('p', 'const self=this; return ((p)=>{const this_=self;' + extractFn(STORE, 'quoteTotal(p)').replace(/^\{/, '').replace(/\}$/, '').replace(/this\._canon/g, 'this_._canon') + '})(p)').bind({ _canon: canon });
  const base = { chairs: 0, guests: 0, chairPrice: 0, platePrice: 0, other: 96000, gstPct: 18, serviceChargePct: 0, discount: 0 };
  assert.equal(Math.round(qt(base).total), 113280, 'pre-discount total');
  const disc = qt({ ...base, discountPct: 10 }).total;
  assert.equal(Math.round(disc), 101952);
  assert.equal(Math.round(disc * 10 / 100), 10195);
  // the flow passes the quote's % discount into every total it computes, and re-derives the advance on render
  assert.match(FLOW, /discountPct:nn\(ev&&ev\.pricing&&ev\.pricing\.discountPct\)/);
  assert.match(FLOW, /\$\("#priceRows"\)\.innerHTML=rows;\n    try\{ updateAdvance\(\); \}catch\(_\)\{ \}/);
  assert.match(FLOW, /function quoteTotal\(\)\{ return BPStore\.pricing\.quoteTotal\(currentInputs\(\)\)\.total; \}/);
});

await t('#2 booklet package chooser uses the booklet formatter (no $ on a rupee booklet)', () => {
  const load = (extra) => { const ctx = { console, Intl, ...extra }; ctx.window = ctx; vm.createContext(ctx); vm.runInContext(r('public/booklet-pkg.js'), ctx); return ctx.HelmBookletPkg; };
  assert.equal(load({ HelmBooklet: { money: (v) => 'INR:' + v } }).money(142500, 'USD'), 'INR:142500');
  const PKG = load({}); PKG.setFormat('en-IN', 'INR');
  assert.ok(!PKG.money(142500, 'USD').includes('$'), 'the quote currency wins over a package currency');
});

await t('#3 default-PIN hint: admins only, only while the server says the PIN is default', () => {
  const P = r('public/shell-b-privacy.js');
  assert.match(P, /var hint = !pinStatusErr && pinStatus && pinStatus\.is_default === true && canChangePin\(\)\n\s+\? " \(Default PIN 0000 — change it in Control Center\.\)" : "";/);
  assert.doesNotMatch(P, /your studio admin can change it/);
});

await t('#4 share dialog explains the version source instead of "No saved quote versions yet"', () => {
  const S = r('public/booklet-share.js');
  assert.doesNotMatch(S, /No saved quote versions yet/);
  assert.match(S, /Only the current quotation \(Version 1\) so far/);
});

await t('#5 booklet has no empty-src <img>; the logo img is created only with a logo', () => {
  assert.doesNotMatch(r('public/booklet.html'), /<img[^>]*id="s_logo"/);
  assert.match(r('public/booklet.js'), /if \(logo && !\$\("#s_logo"\)\) \{ const im = doc\.createElement\("img"\)/);
});

await t('#6/#7 search: theme / colour / color find the theme picker; 2fa opens Two-step sign-in', async () => {
  const CAT = require('../public/search-catalog.js'), SSC = require('../public/settings-search-core.js');
  const list = await CAT.entriesFor({ role: async () => 'admin', canView: async () => true }, {});
  for (const q of ['theme', 'colour', 'color']) assert.equal(CAT.rank(q, list, SSC, 1)[0].text, 'Colour theme', q);
  const top = CAT.rank('2fa', list, SSC, 1)[0];
  assert.equal(top.kind, 'account'); assert.deepEqual(top.open, { section: 'settings', focus: 'mfa' });
  let clicked = 0; const win = { document: { getElementById: (id) => id === 'hbThemePick' ? { click: () => clicked++ } : null, querySelector: () => null } };
  assert.equal(CAT.openAccountItem({ theme: true }, win), true);
  await new Promise((res) => setTimeout(res, 5)); assert.equal(clicked, 1);
  let opened = null; assert.equal(CAT.openAccountItem({ section: 'settings', focus: 'mfa' }, { HelmAuthUI: { openAccount: (o) => { opened = o; } } }), true);
  assert.deepEqual(opened, { section: 'settings', focus: 'mfa' });
  assert.match(r('public/control-split.js'), /CAT\.openAccountItem\(o,window\)/);
  assert.match(r('public/studio-search.js'), /HelmSearchCatalog\.openAccountItem\(r\.open \|\| \{\}, global\)/);
});

await t('#8 CRM history: archive reads ARCHIVED, a restore reads RESTORED', () => {
  const C = r('public/crm.html');
  const fn = new Function('return (' + 'function crmActionLabels' + C.slice(C.indexOf('function crmActionLabels') + 'function crmActionLabels'.length, C.indexOf('  // Restore a DELETED lead')) + ')')();
  const rows = [
    { action: 'created', lead_id: 'L1', archived_at: '2026-10-10T10:05:00Z' },
    { action: 'deleted', lead_id: 'L1', archived_at: '2026-10-10T10:00:00Z', restored_at: '2026-10-10T10:05:01Z' },
    { action: 'created', lead_id: 'L1', archived_at: '2026-10-09T09:00:00Z' },
    { action: 'created', lead_id: 'L2', archived_at: '2026-10-09T09:00:00Z' },
  ];
  const m = fn(rows);
  assert.deepEqual(rows.map((x) => m.get(x)), ['restored', 'archived', 'created', 'created']);
  assert.match(C, /\$\{esc\(actLabel\.get\(r\)\|\|r\.action\)\}/);
});

await t('#9 lead Convert opens the studio-prefixed /<studio>/flow route (served by vercel + server.js)', () => {
  assert.match(r('public/leads.html'), /location\.href=\(window\.HelmUrl&&HelmUrl\.upgrade\)\?HelmUrl\.upgrade\(h\):h;/);
  const v = JSON.parse(r('vercel.json'));
  assert.ok(v.rewrites.some((x) => x.source === '/([a-z0-9-]+)/flow' && x.destination === '/flow'));
  assert.match(r('server.js'), /\|command\|ready\|ops\|issues\|flow\)/);
  assert.match(FLOW, /<base href="\/">/);
  // HelmUrl: flow.html?quote= -> /<studio>/flow?quote=
  const core = STORE.slice(STORE.indexOf('var HelmUrl = (function'), STORE.indexOf('window.HelmUrl = HelmUrl;'));
  const ctx = { location: { pathname: '/sharma-events/leads', search: '' }, URLSearchParams, encodeURIComponent, decodeURIComponent,
    sessionStorage: { getItem: () => 'sharma-events', setItem() {} } };
  ctx.window = ctx; vm.createContext(ctx); vm.runInContext(core + '\nthis.HelmUrl = HelmUrl;', ctx); const H = ctx.HelmUrl;
  assert.equal(H.upgrade('flow.html?quote=u1'), '/sharma-events/flow?quote=u1');
  assert.equal(H.parse('/sharma-events/flow').page, 'flow');
});

await t('#10 bare settlement / budget / closure show a "Pick an event" list', async () => {
  for (const p of ['settlement', 'budget', 'closure']) {
    const h = r('public/' + p + '.html');
    assert.match(h, /if\(!id\)\{ if\(window\.HelmPickEvent\) HelmPickEvent\.show\(\$\("#notfound"\),"/);
    assert.match(h, /<script src="pick-event\.js\?v=1"><\/script>/);
  }
  const PE = require('../public/pick-event.js');
  assert.equal(PE._href('settlement', 'a b'), 'settlement.html?quote=a%20b');
  assert.equal(PE._pickable({ id: 'x', status: 'lost' }), false);
  assert.equal(PE._pickable({ id: 'x', status: 'confirmed' }), true);
});

await t('#11 empty KPI tile stays data-money so hidden amounts show ••••', () => {
  const M = r('public/shell-b-money.js');
  assert.doesNotMatch(M, /removeAttribute\("data-money"\)/);
  assert.match(M, /if \(o\.value == null\) \{ v\.textContent = "—"; \} else countUp/);
});

await t('#12 a successful Confirm & lock clears the stale validation error', () => {
  const Q = r('public/quotes.html');
  const i = Q.indexOf('closeConfirm(); BPUI.toast((confirmIt?"Quote confirmed and locked."');
  const pre = Q.slice(i - 400, i);
  assert.match(pre, /ce\.hidden=true; ce\.textContent="";/);
  assert.match(pre, /\.bpui-toast/);
});

await t('#13 payment badge follows the advance, not the quote status', () => {
  assert.match(FLOW, /function paintBookingBadge\(paidCount\)/);
  assert.match(FLOW, /if\(ev&&ev\.status==='confirmed'\)\{ b\.textContent="Advance pending"; b\.hidden=false; return; \}/);
  assert.match(FLOW, /const paid=pays\.filter\(p=>p\.status==='paid'\);\n    paintBookingBadge\(paid\.length\);/);
  assert.doesNotMatch(FLOW, /if\(ev\.status==='confirmed' \|\| \(\(ev\.approvalStatus/);
});

await t('#14 profile menu: Escape anywhere resets aria-expanded via closeMenu', () => {
  const A = r('public/auth-ui.js');
  assert.match(A, /function escDoc\(e\) \{ if \(e\.key === "Escape" && menu\.open\) closeMenu\(true\); \}/);
  assert.match(A, /doc\.addEventListener\("keydown", escDoc\);/);
  assert.match(A, /doc\.removeEventListener\("keydown", escDoc\);/);
});

console.log(`\n${n} staging-1026 checks passed`);
