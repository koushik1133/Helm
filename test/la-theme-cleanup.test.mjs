// la-theme-cleanup.test.mjs — live-audit (Oct 2026) theme + production clean-up items:
//  19/47 visible violet/indigo -> green/graphite tokens (and no inline violet :root tokens left)
//  21 no developer footer on production + per-route titles · 40 dead #loginModal removed · 41 <meta charset> first
//  26 Hide amounts replaces the TEXT (screen readers / Ctrl+F / copy) · 27 one studio-locale/timezone date formatter
//  28 stageLabel()/sourceLabel() everywhere · 29 "Untitled event" when the title is the code · 34 CRM full history
//  9-11 currency labels follow the studio / quote currency
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const r = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0; const t = async (name, fn) => { try { await fn(); n++; console.log('  ok', name); } catch (e) { console.error('FAIL', name); throw e; } };

/* ------------------------------------------------------------------ 19 / 47: theme */
const VIOLET = /#(6d28d9|7c3aed|4f46e5|efe9ff|6b46c1|9333ea|5b21b6|b9a4f5|e7e0ff|4457c8|f2eefc|c4b5fd|8b5cf6|1d1730|2c2346|2a1f4a)(?![0-9a-f])|rgba\(109, ?40, ?217/i;
// deliberate non-theme colours: client invitation templates, 3D decor palettes, the builder's AV category hue,
// and the user-selectable midnight / studio / luxe theme definitions
const ALLOW = new Set(['invite.html', 'invite-studio.html', 'builder-3d.js', 'builder.js', 'photo-render-prompt.js', 'shell-b.css', 'builder-v2.css',
  'demo.css', 'public-v2.css', 'public-pages-v2.css', 'shell-b-theme-studio.css', 'shell-b-theme-luxe.css', 'shell-b-pages.css', 'shell-b-style.css', 'shell-proto.js']);
await t('no violet / indigo left in app pages, styles and scripts (outside the allow-list)', () => {
  const bad = [];
  for (const f of readdirSync(new URL('../public/', import.meta.url)).filter((x) => /\.(html|css|js)$/.test(x))) {
    if (ALLOW.has(f)) continue;
    r('public/' + f).split('\n').forEach((l, i) => { if (VIOLET.test(l)) bad.push(f + ':' + (i + 1)); });
  }
  assert.deepEqual(bad, []);
  // the allow-listed invite studio still has an emerald page :root (only its template swatches keep their colours)
  assert.match(r('public/invite-studio.html'), /--accent:#047857;--accent-2:#036b4d;--accent-soft:#e3f4ed;/);
});
await t('inline :root accent tokens are emerald on every page (no dead violet tokens)', () => {
  const pages = readdirSync(new URL('../public/', import.meta.url)).filter((x) => x.endsWith('.html'));
  for (const p of pages) for (const m of r('public/' + p).matchAll(/--accent:(#[0-9a-f]{6});--accent-2:(#[0-9a-f]{6})/gi)) {
    if (p === 'invite.html') continue;
    assert.equal(m[1].toLowerCase(), '#047857', p); assert.equal(m[2].toLowerCase(), '#036b4d', p);
  }
  assert.match(r('public/builder.css'), /--accent:#047857;\n\s+--accent-soft:#e3f4ed;/);
});
await t('the spots the audit saw on screen use green / graphite', () => {
  const cal = r('public/calendar.html');
  assert.match(cal, /\.stb\.lead\{background:#f1f1f1;color:#404040;border-style:dotted;border-color:#a3a3a3\}/, 'calendar Lead badge: graphite');
  assert.match(r('public/vendors.html'), /\.kind\.freelancer\{background:#f1f1f1;color:#404040\}/);
  assert.match(r('public/control.html'), /special:'<span style="color:#33403b">special<\/span>'/);
  assert.match(r('public/chat.html'), /const NAME_COLORS=\["#047857","#374151",/);
  assert.match(r('public/quotes.html'), /\.stat\.q\{background:#eef1f0;color:#2f4a42\}/);
  assert.match(r('public/quotes.html'), /html\[data-theme="dark"\] \.tabs button\.on\{background:#047857\}/);
  assert.match(r('public/shell-b-pages.css'), /html\[data-shell="b"\] \.stat\.q \{ background: var\(--hb-bg2\); color: var\(--hb-ink2\);/);
  assert.match(r('public/404.html'), /var\(--accent-2\) 60%,#10a37a\)/);
  assert.match(r('public/theme.css'), /\.skip-link \{[^}]*var\(--accent, #047857\)/);
  assert.match(r('public/theme.css'), /--accent: #34d399; --accent-2: #10b981; --accent-soft: #123329;/);
  assert.match(r('public/builder.css'), /background:var\(--accent-soft,#e3f4ed\)/);
});

/* ------------------------------------------------------------------ 21 / 40 / 41 */
await t('dashboard: route title + no developer footer on production', () => {
  const d = r('public/dashboard.html');
  assert.match(d, /<title>Dashboard — Helm Events<\/title>/);
  assert.doesNotMatch(d, /runs locally/);
  assert.match(d, /<span id="footDev" hidden> · storage: <span id="footMode">/);
  assert.match(d, /fd\.hidden = !\/\^\(localhost\|127\\\.0\\\.0\\\.1\|\\\[::1\\\]\)\$\/\.test\(location\.hostname\)/);
  assert.match(r('public/builder.html'), /<title>Layout builder — Helm Events<\/title>/);
});
await t('dead in-page sign-in popup removed from insights / reports / quotes / calendar', () => {
  for (const p of ['insights', 'reports', 'quotes', 'calendar']) {
    const h = r('public/' + p + '.html');
    assert.doesNotMatch(h, /loginModal|id="li_pw"|id="li_pass"|function openLogin|type="password"/, p);
  }
});
await t('<meta charset> is the first thing in <head> on insights and reports', () => {
  for (const p of ['insights', 'reports']) assert.match(r('public/' + p + '.html'), /<head>\n<meta charset="utf-8">\n/, p);
});

/* ------------------------------------------------------------------ 27 / 28: one formatter + labels */
const store = r('public/store-api.js');
function B(cc, tz) {
  const ti = store.indexOf('BPStore.tax = (function () {'), te = store.indexOf('})();', ti) + 5;
  const pick = (name) => { const s = store.indexOf('BPStore.' + name + ' = function'); assert.ok(s > 0, name); const e = store.indexOf('\n  };\n', s); return store.slice(s, e + 5); };
  const vars = (name) => { const s = store.indexOf(name); return store.slice(s, store.indexOf('\n', s) + 1); };
  const H = require('../public/country-profile.js');
  const mem = {}; const ls = { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); } };
  const ctx = { BPStore: { countries: () => [] }, window: { HelmCountry: H }, HelmCountry: H, localStorage: ls, Intl, Date };
  ctx.globalThis = ctx; vm.createContext(ctx);
  const stageBlk = store.slice(store.indexOf('  var STAGE_LABELS = {'), store.indexOf('  BPStore.stageLabel = function'));
  const srcBlk = store.slice(store.indexOf('  var SOURCE_LABELS = {'), store.indexOf('  BPStore.sourceLabel = function'));
  vm.runInContext(store.slice(ti, te) + vars('var STUDIO_TZ_KEY') + stageBlk + srcBlk +
    ['rememberStudioTimezone', 'studioTimezone', 'studioLocale', 'fmtStudioDate', 'fmtDateIN', 'fmtDay', 'fmtDateTime', 'stageLabel', 'sourceLabel'].map(pick).join('\n'), ctx);
  const st = ctx.BPStore.tax.resolve({ taxCountry: cc }); ctx.BPStore.studioTax = () => st;
  if (tz) ctx.BPStore.rememberStudioTimezone(tz);
  return ctx.BPStore;
}
await t('fmtStudioDate: studio locale; a calendar day never moves; a timestamp reads in the STUDIO timezone', () => {
  const IN = B('IN', 'Asia/Kolkata'), US = B('US', 'America/Chicago');
  assert.equal(IN.fmtStudioDate('2026-12-20'), '20/12/2026');
  assert.equal(US.fmtStudioDate('2026-12-20'), '12/20/2026');
  assert.equal(IN.fmtDateIN('2026-12-20'), '20/12/2026', 'India output unchanged');
  assert.equal(US.fmtDateIN('2026-12-20'), '12/20/2026', 'a US studio gets its own order');
  // 20:00 UTC on 20 Dec is already 21 Dec in Kolkata but still 20 Dec in Chicago - whatever the viewer's clock says
  assert.equal(IN.fmtStudioDate('2026-12-20T20:00:00Z'), '21/12/2026');
  assert.equal(US.fmtStudioDate('2026-12-20T20:00:00Z'), '12/20/2026');
  assert.match(IN.fmtStudioDate('2026-12-20T20:00:00Z', { time: true }), /^21\/12\/2026, 01:30\s?am$/i);
  assert.equal(IN.fmtStudioDate('2026-12-20', { style: 'long' }), '20 Dec 2026');
  assert.equal(IN.fmtStudioDate('2026-12-20', { style: 'weekday' }), 'Sunday');
  assert.equal(IN.fmtStudioDate('2026-12-20', { fmt: { weekday: 'short', day: 'numeric', month: 'short' } }), 'Sun, 20 Dec');
  assert.equal(IN.fmtStudioDate(''), ''); assert.equal(IN.fmtStudioDate('not a date'), 'not a date');
  assert.equal(B('IN').studioTimezone(), 'Asia/Kolkata', 'no saved zone: the country default');
  assert.equal(B('IN', 'Not/AZone').studioTimezone(), 'Asia/Kolkata', 'an invalid saved zone is ignored');
});
await t('stageLabel / sourceLabel: no raw lowercase keys, "Walk-in" everywhere', () => {
  const b = B('IN');
  assert.equal(b.stageLabel('won'), 'Won'); assert.equal(b.stageLabel('proposal'), 'Proposal'); assert.equal(b.stageLabel('event_day'), 'Event Day');
  assert.equal(b.stageLabel('in_progress'), 'In progress'); assert.equal(b.stageLabel(''), '');
  assert.equal(b.sourceLabel('walk-in'), 'Walk-in'); assert.equal(b.sourceLabel('Walk-In'), 'Walk-in'); assert.equal(b.sourceLabel('walk in'), 'Walk-in');
  assert.equal(b.sourceLabel('instagram'), 'Instagram'); assert.equal(b.sourceLabel('trade fair'), 'Trade fair');
});
await t('pages use the shared formatter + labels', () => {
  const crm = r('public/crm.html'), leads = r('public/leads.html'), dash = r('public/dashboard.html'), sbd = r('public/shell-b-dash.js'), cal = r('public/calendar.html');
  assert.match(crm, /const when=\(t\)=>\{ if\(!t\) return ""; return BPStore\.fmtStudioDate\(t,/);
  assert.doesNotMatch(crm, /toLocaleString\("en-IN"/);
  assert.match(crm, /\$\{esc\(stgLbl\(s\)\)\}<\/option>/, 'CRM stage dropdown');
  assert.match(crm, /<td class="muted">\$\{esc\(stgLbl\(r\.status\)\)\}<\/td>/, 'CRM stage column');
  assert.match(crm, /if\(!srcMap\[k\]\) srcMap\[k\]=srcLbl\(c\);/, 'CRM source filter: Walk-in, never Walk-In');
  assert.match(leads, /\["Date", l\.event_date\?BPStore\.fmtDateIN\(l\.event_date\):""\]/);
  assert.match(dash, /stg\(e\.lifecycle_stage\)/); assert.match(dash, /esc\(stg\(t\.status\)\)/);
  assert.doesNotMatch(sbd, /toLocale(Date|Time)String\(undefined, \{/, 'dashboard: no browser-locale dates (only the dfmt/tfmt fallbacks)');
  assert.doesNotMatch(r('public/shell-b-money.js'), /toLocaleDateString\(undefined, \{/);
  assert.match(sbd, /function dfmt\(d, f\) \{ try \{ return S\(\)\.fmtStudioDate\(iso\(d\), \{ fmt: f \}\);/);
  assert.match(cal, /const fmtDate=\(d\)=>\{ if\(!validDate\(d\)\) return "—"; return BPStore\.fmtStudioDate\(d,\{style:"long"\}\); \};/);
  assert.match(cal, /\.day \.hd \.dt\{font-weight:700;font-size:14px\}/, 'calendar day headings: not monospace');
  assert.doesNotMatch(r('public/crew-schedule.js'), /toLocale(Date|Time)String\("en-IN"/);
  assert.match(r('public/studio-search.js'), /const prettySub = \(sub\) => sub\.split\(" · "\)/);
});

/* ------------------------------------------------------------------ 29: Untitled event */
await t('listName: "Untitled event" when the only name is the code', () => {
  const N = require('../public/event-name.js');
  assert.equal(N.listName({ code: '10182026-01', title: '10182026-01' }), 'Untitled event');
  assert.equal(N.listName({ code: '10182026-01', title: '' }), 'Untitled event');
  assert.equal(N.listName({ code: '10182026-01', title: 'Sharma wedding' }), 'Sharma wedding');
  assert.equal(N.displayName({ code: '10062026-09', title: '' }), '10062026-09', 'displayName itself is unchanged');
  assert.match(r('public/calendar.html'), /<span class="ttl">\$\{esc\(evName\(e\)\)\}<\/span>/);
  assert.match(r('public/chat.html'), /HelmEventName\.listName\(q\)/);
  assert.match(r('public/shell-b-dash.js'), /if \(H && H\.listName\) return H\.listName\(q\);/);
  assert.match(r('public/dashboard.html'), /if \(H && H\.listName\) return H\.listName\(q\);/);
});

/* ------------------------------------------------------------------ 34: CRM full history */
const C = r('public/crm.html');
const labels = new Function('return (function crmActionLabels' + C.slice(C.indexOf('function crmActionLabels') + 'function crmActionLabels'.length, C.indexOf('  // Restore a DELETED lead')) + ')')();
const group = new Function('return (function crmGroupDuplicates' + C.slice(C.indexOf('function crmGroupDuplicates') + 'function crmGroupDuplicates'.length, C.indexOf('  // PL1027 #4')) + ')')();
await t('CRM: sample/seed rows written in the same moment are never RESTORED', () => {
  const at = '2026-10-18T08:43:10.000Z';
  const rows = [{ id: 'b', lead_id: 'L', action: 'updated', archived_at: at }, { id: 'a', lead_id: 'L', action: 'created', archived_at: at }];
  const m = labels(rows); assert.equal(m.get(rows[1]), 'created'); assert.equal(m.get(rows[0]), 'updated');
  // a created row 2 s after the first write (seed + link in one go) is not a restore either
  const rows2 = [{ lead_id: 'L', action: 'created', archived_at: '2026-10-18T08:43:12Z' }, { lead_id: 'L', action: 'updated', archived_at: '2026-10-18T08:43:10Z' }];
  assert.equal(labels(rows2).get(rows2[0]), 'created');
  // a real restore (archive row present) is still RESTORED
  const rows3 = [{ lead_id: 'L', action: 'created', archived_at: '2026-10-19T10:00:00Z' }, { lead_id: 'L', action: 'deleted', archived_at: '2026-10-18T10:00:00Z' }];
  assert.equal(labels(rows3).get(rows3[0]), 'restored');
  // archive row not on screen, re-created an hour later: still RESTORED (unchanged rule)
  const rows4 = [{ lead_id: 'L', action: 'created', archived_at: '2026-10-18T11:00:00Z' }, { lead_id: 'L', action: 'updated', archived_at: '2026-10-18T10:00:00Z' }];
  assert.equal(labels(rows4).get(rows4[0]), 'restored');
  // a SAMPLE lead (store flags is_demo from leads.is_demo) keeps its own word even after a delete row
  const rows5 = [{ lead_id: 'D', action: 'created', is_demo: true, archived_at: '2026-10-19T10:00:00Z' }, { lead_id: 'D', action: 'deleted', is_demo: true, archived_at: '2026-10-18T10:00:00Z' }];
  assert.equal(labels(rows5).get(rows5[0]), 'created');
  assert.match(r('public/store-api.js'), /await supa\.from\("leads"\)\.select\("id"\)\.in\("id", lids\)\.eq\("is_demo", true\);/);
});
await t('CRM: identical rows within a minute show once with a count; the checkbox has a name', () => {
  const base = { lead_id: 'L', action: 'updated', name: 'Asha', status: 'new' };
  const rows = [{ ...base, archived_at: '2026-10-18T08:43:50Z' }, { ...base, archived_at: '2026-10-18T08:43:20Z' }, { ...base, archived_at: '2026-10-18T08:40:00Z' }, { ...base, status: 'won', archived_at: '2026-10-18T08:39:50Z' }];
  const g = group(rows, new Map());
  assert.deepEqual(g.map((x) => x.n), [2, 1, 1]);
  assert.match(C, /<input type="checkbox" id="fAll" aria-label="Full history: show every saved record, not only the latest per lead">/);
  assert.match(C, /×\$\{esc\(g\.n\)\}<\/span>/);
});

/* ------------------------------------------------------------------ 9-11: currency labels */
await t('currency labels follow the quote / studio currency', () => {
  const f = r('public/flow.html');
  assert.equal((f.match(/\(<span class="cur-sym">₹<\/span>\)/g) || []).length, 6, 'the 6 flow money labels');
  assert.match(f, /function syncCurLabels\(\)\{ let sym="₹"; try\{ const r=fTax\(\);/);
  assert.match(f, /function renderPrice\(\)\{ syncQtyHints\(\); syncCurLabels\(\);/);
  assert.match(f, /This quote is empty \("\+inr\(0\)\+"\)/);
  assert.match(f, /Ref \$\{esc\(ev\.code\|\|''\)\} · \$\{esc\(BPStore\.quoteDate\(Date\.now\(\), fTax\(\)\)\)\}/);
  assert.doesNotMatch(f, /toLocaleDateString\(['"]en-IN['"]/);
  const c = r('public/control.html');
  assert.match(c, /\$\{esc\(BPStore\.studioSymbol\?BPStore\.studioSymbol\(\):"₹"\)\}\/plate<\/label>/);
  assert.doesNotMatch(c, />₹\/plate</);
  const q = r('public/quotes.html');
  assert.match(q, /<footer id="taxFoot">Every save is a version · confirm to price &amp; lock<\/footer>/);
  assert.match(q, /if\(r\.country==="IN"\)\{ \$\("#taxFoot"\)\.textContent="Every save is a version · confirm to price & lock · GST per India \(SAC 998596, 18%\)"; return; \}/);
});

/* ------------------------------------------------------------------ 26: Hide amounts replaces the text */
const P = r('public/shell-b-privacy.js');
await t('privacy: masking swaps the text for •••• (kept in memory) and restores it on show', () => {
  assert.match(P, /var MASK = "\\u2022\\u2022\\u2022\\u2022"/);
  assert.match(P, /sp\.setAttribute\("role", "img"\); sp\.setAttribute\("aria-label", "Amount hidden"\);/);
  assert.match(P, /function unmaskAll\(\)/); assert.match(P, /realText: realText/);
  assert.match(P, /if \(e\.querySelector && e\.querySelector\("input,select,textarea,\[contenteditable\]"\)\) return false;/, 'never hides a control the user types into');
  assert.match(r('public/shell-b-dash.js'), /HelmPrivacy\.realText\(s\)/, 'tagMoney reads past a hidden amount');
  assert.match(r('public/chat.html'), /n\.innerHTML=highlight\(\(window\.HelmPrivacy&&HelmPrivacy\.realText\)\?HelmPrivacy\.realText\(n\):n\.textContent,q\)/);
});
let pw = null; try { pw = await import('playwright'); } catch (e) {}
let br = null; if (pw) { try { br = await pw.chromium.launch(); } catch (e) { br = null; } }
if (!br) console.log('  - headless privacy check skipped (no playwright browser)');
else await t('privacy (headless): hidden amounts are not in the page text; a re-render while hidden is kept; show restores', async () => {
  const pg = await br.newPage(); const errs = []; pg.on('pageerror', (e) => errs.push(String(e)));
  await pg.setContent('<html><body><div id="a">Total ₹1,20,000</div><p id="b">The quote is worth ₹50,000 and due soon</p><span id="c" data-money><b>AED 4,000</b></span><div><input id="amt" type="number" value="500"></div><div id="e">Guests 120</div></body></html>');
  await pg.addScriptTag({ content: P }); await pg.waitForTimeout(60);
  const h = await pg.evaluate(() => ({ txt: document.body.innerText, inp: document.getElementById('amt').value, real: HelmPrivacy.realText(document.getElementById('b')) }));
  assert.doesNotMatch(h.txt, /1,20,000|50,000|4,000/); assert.match(h.txt, /Guests 120/); assert.equal(h.inp, '500'); assert.equal(h.real, 'The quote is worth ₹50,000 and due soon');
  await pg.evaluate(() => { document.getElementById('a').textContent = 'Total ₹2,00,000'; }); await pg.waitForTimeout(200);
  assert.equal(await pg.evaluate(() => document.getElementById('a').textContent), '••••');
  await pg.evaluate(() => HelmPrivacy.show()); await pg.waitForTimeout(80); await pg.keyboard.type('0000'); await pg.waitForTimeout(300);
  const s = await pg.evaluate(() => ({ a: document.getElementById('a').textContent, b: document.getElementById('b').textContent, c: document.getElementById('c').textContent }));
  assert.deepEqual(s, { a: 'Total ₹2,00,000', b: 'The quote is worth ₹50,000 and due soon', c: 'AED 4,000' });
  assert.deepEqual(errs, []);
});
if (br) await br.close();
console.log(`la-theme-cleanup: ${n} checks passed`);
