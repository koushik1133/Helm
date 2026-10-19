// r20-flow.test.mjs - live QA (prod /sita, free trial) on the quote list / quote page / event stage strip:
//  1 quotes "⋯" row menu floats on <body> (position:fixed) so the table's scroll box can't clip it
//  2 staff-only "Preview quote" on the quote page: no save, no approval link, no status change
//  3 a hand-typed Décor / setup value survives the builder round trip + "Layout suggests ₹X - Use it"
//  4 the quotes list reads the same name fields the event page uses (city / venue / guests)
//  5 the activity trail lists quotation versions (Q1, Q2…) as well as layout versions
//  6 the stage strip ticks Discovery / Proposal only when something is recorded
//  7 BPUI.toast: one card per identical text across lanes + a burst guard
//  8 the saved-venue <select> has an accessible name
//  9 venue address does not repeat the city
// 10 an empty hall length / breadth is prefilled from the linked venue's size
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const QUOTES = read('public/quotes.html'), QCSS = read('public/quotes-polish.css');
const FLOW = read('public/flow.html'), EV = read('public/event.html'), API = read('public/store-api.js');
const tests = []; const t = (n, f) => tests.push([n, f]);

t('1 row menu: portal to body while open, fixed + flip, closes on outside click / scroll / resize / Esc / re-render', () => {
  assert.match(QUOTES, /dm\.addEventListener\("toggle",\(\)=>\{ if\(dm\.open\) qmoreOpen\(dm,sm,pop\); else qmoreClose\(dm\); \}\);/);
  assert.match(QUOTES, /pop\.classList\.add\("qmore-float"\); document\.body\.appendChild\(pop\);/);
  assert.match(QUOTES, /document\.addEventListener\("pointerdown",[^\n]*qmoreClose\(\); \},true\);/);
  assert.match(QUOTES, /window\.addEventListener\("scroll",[^\n]*qmoreClose\(\); \},true\);/);
  assert.match(QUOTES, /e\.key==="Escape"&&qmoreCur/);
  assert.match(QUOTES, /function render\(\)\{\n    qmoreClose\(\);/);
  assert.match(QCSS, /\.qmore-pop\.qmore-float\{position:fixed;/);
});

t('2 staff preview: textContent only, never saves / sends / generates a token', () => {
  assert.match(FLOW, /id="q_preview"/);
  assert.match(FLOW, /id="qPreviewModal" class="lmodal" hidden role="dialog" aria-modal="true"/);
  const a = FLOW.indexOf('  function previewQuote(){'), b = FLOW.indexOf('/* ---------- requirements ---------- */', a);
  const fn = FLOW.slice(a, b);
  assert.ok(a > 0 && b > a);
  assert.doesNotMatch(fn, /innerHTML|generateToken|saveQuotation|approval\.|\.save\(|insertAdjacentHTML|document\.write/);
  assert.match(fn, /textContent/);
});

t('3 décor: typed value remembered before the builder, wins on return, "Use it" hint', () => {
  assert.match(FLOW, /id="q_otherLayout"[^>]*hidden><span id="q_otherLayoutTxt"><\/span> <button type="button" class="btn ghost" id="q_otherUseLayout">Use it<\/button>/);
  assert.equal((FLOW.match(/rememberTypedOther\(\);/g) || []).length, 2, 'both builder trips');
  assert.match(FLOW, /const typed=fromBuilder\?takeTypedOther\(\):null;/);
  assert.match(FLOW, /"Layout suggests "\+inr\(auto\)/);
});

t('4 list name: QUOTE_PAGE_COLS carries city / venue / address / guests; nameOnly passes guests on', () => {
  const m = /const QUOTE_PAGE_COLS = ((?:"[^"]*"\s*\+?\s*)+);/.exec(API); assert.ok(m);
  const cols = vm.runInNewContext(m[1]).split(',');
  for (const k of ['client_city:client->>city', 'client_venue:client->>venue', 'client_address:client->>address', 'client_guests:client->>guests'])
    assert.ok(cols.includes(k), k);
  assert.ok(!cols.some((c) => /approval_token/.test(c)));
  const src = /const nameOnly = [\s\S]*?\n  function mapQuoteSummary\(q\) \{[\s\S]*?\n  \}\n/.exec(API)[0];
  const cx = vm.createContext({}); vm.runInContext(src + '\nthis.m = mapQuoteSummary;', cx);
  const row = cx.m({ id: 'q', code: '10182026-01', title: 'WED_HYD_200_03DEC26', event_type: 'Wedding', event_date: '2026-12-03',
    client_name: 'A', client_city: 'Hyderabad', client_guests: '200' });
  const N = require('../public/event-name.js');
  assert.equal(N.displayName(row), 'WED_HYD_200_03DEC26');
  // the same quote read in full (event page) gives the same name
  assert.equal(N.displayName({ code: '10182026-01', title: 'WED_HYD_200_03DEC26', eventType: 'Wedding', eventDate: '2026-12-03',
    client: { city: 'Hyderabad', guests: 200 } }), 'WED_HYD_200_03DEC26');
});

t('5 activity trail: quotation versions merged, newest first, wording honest', () => {
  assert.match(FLOW, /BPStore\.quotationVersions\.list\(id\)\)\|\|\[\]; \}catch\(_\)\{ qv=\[\]; \}/);
  assert.match(FLOW, /kind:"qversion"/);
  assert.match(FLOW, /quotation versions \(Q1, Q2…\), layout versions/);
});

t('6 stage strip: Discovery / Proposal ticked only when filled; unknown keeps the tick', () => {
  const a = EV.indexOf('  let discLoaded=false'), b = EV.indexOf('\n  }\n', EV.indexOf('function stageMet', a)) + 4;
  const cx = vm.createContext({ discSummary: null, propSummary: null });
  vm.runInContext(EV.slice(a, b).replace(/^  let /m, 'var ') + '\nthis.stageMet=stageMet; this.set=(d,p,dl,pl)=>{ discSummary=d; propSummary=p; discLoaded=dl; propLoaded=pl; };', cx);
  cx.set(null, null, false, false);
  assert.equal(cx.stageMet('discovery'), true); assert.equal(cx.stageMet('proposal'), true);
  cx.set({ disc: { budget_max: 500000 }, total: 0 }, null, true, true);
  assert.equal(cx.stageMet('discovery'), false, 'a budget alone is step 1, not discovery');
  assert.equal(cx.stageMet('proposal'), false, 'no proposal row');
  cx.set({ disc: null, total: 2 }, { concept: 'Royal', scope: [] }, true, true);
  assert.equal(cx.stageMet('discovery'), true); assert.equal(cx.stageMet('proposal'), true);
  assert.equal(cx.stageMet('lead'), true);
  assert.match(EV, /class:"step"\+\(done\?" done":skipped\?" skipped":i===cur\?" active":""\)/);
});

t('7 toast: same text in either lane is one card; burst guard', () => {
  assert.match(API, /toastRoot\.querySelectorAll\("\.bpui-toast"\), function \(t\) \{ if \(t\.__bpuiKey === key \|\| t\.__bpuiSame === same\) existing = t; \}\);/);
  assert.match(API, /if \(toastRecent\[same\] && nowMs - toastRecent\[same\] < 1500\) return;/);
});

t('8 saved-venue select has an accessible name', () => {
  assert.match(read('public/venue-picker.js'), /h\("select", \{ id: "vp_pick", "aria-label": "Pick a saved venue"/);
});

t('9 address: city not repeated', () => {
  const g = {}; vm.runInNewContext(read('public/venues-core.js'), { window: g, globalThis: g });
  const V = g.HelmVenues;
  assert.equal(V.joinAddress('Banjara Hills, Hyderabad', 'Hyderabad'), 'Banjara Hills, Hyderabad');
  assert.equal(V.joinAddress('Shamshabad Road', 'Hyderabad'), 'Shamshabad Road, Hyderabad');
  assert.equal(V.joinAddress('Secunderabad Rd', 'Hyderabad'), 'Secunderabad Rd, Hyderabad');
  assert.equal(V.joinAddress('', 'Pune'), 'Pune');
  assert.equal(V.fillFor({ name: 'X', address: 'Banjara Hills, Hyderabad', city: 'hyderabad' }).address, 'Banjara Hills, Hyderabad');
  assert.match(read('public/venue-suggest.js'), /\.test\(a\) \? a : a \+ ", " \+ c;/);
});

t('10 hall size: empty fields prefilled from the linked venue, typed values kept', () => {
  assert.match(FLOW, /if\(\$\("#g_len"\)\.value==="" && \+cl\.venueLen>0\) \$\("#g_len"\)\.value=String\(\+cl\.venueLen\);/);
  assert.match(FLOW, /if\(\$\("#g_wid"\)\.value==="" && \+cl\.venueWid>0\) \$\("#g_wid"\)\.value=String\(\+cl\.venueWid\);/);
});

let failed = 0;
for (const [n, f] of tests) { try { f(); console.log('  ok', n); } catch (e) { failed++; console.log('  FAIL', n, '\n   ', e.message); } }
console.log(`r20-flow: ${tests.length - failed} passed, ${failed} failed`);
if (failed) process.exit(1);
