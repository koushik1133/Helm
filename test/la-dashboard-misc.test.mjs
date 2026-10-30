// la-1018 (live audit 2026-10-18, items 10/12, 22, 30, 31, 35, 36, 39, 42): dashboard numbers from one source,
// dashboard polish, sidebar, leads / nurture / vendors form fixes, studio-path routing.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const read = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
let n = 0, failed = 0;
const t = (name, fn) => { try { fn(); n++; console.log('ok -', name); } catch (e) { failed++; console.log('FAIL -', name, '\n   ', e.message); } };

const DASH = read('public/shell-b-dash.js'), DCSS = read('public/shell-b-dash.css');
const SHELL = read('public/shell-b.js'), SCSS = read('public/shell-b.css');
const LEADS = read('public/leads.html'), VEND = read('public/vendors.html'), NUR = read('public/nurture.html');

// pull the shared lead helpers out of the dashboard and run them
function dashFns() {
  const a = DASH.indexOf('  function uncontacted(l)'), b = DASH.indexOf('  function countUp(');
  assert.ok(a > 0 && b > a, 'lead helpers present');
  const ctx = { window: {} }; vm.createContext(ctx);
  vm.runInContext(DASH.slice(a, b) + '\nthis.uncontacted = uncontacted; this.leadConv = leadConv;', ctx);
  return ctx;
}

t('#10 one "not contacted" rule: sidebar badge + dashboard share HelmLeadRules.uncontacted', () => {
  const ctx = { window: {} }; vm.createContext(ctx);
  const m = /window\.HelmLeadRules = window\.HelmLeadRules \|\| \{[^\n]+\};/.exec(SHELL); assert.ok(m, 'shell defines HelmLeadRules');
  vm.runInContext(m[0], ctx);
  const R = ctx.window.HelmLeadRules, D = dashFns();
  const rows = [{ status: 'new' }, { status: 'new', quote_id: 'q' }, {}, { status: 'contacted' }, { status: 'won' }, null];
  assert.deepEqual(rows.map((r) => R.uncontacted(r)), [true, false, true, false, false, false]);
  assert.deepEqual(rows.map((r) => D.uncontacted(r)), [true, false, true, false, false, false], 'dashboard fallback = same rule');
  assert.match(SHELL, /railCount\("leads", \(Array\.isArray\(rows\) \? rows : \[\]\)\.filter\(window\.HelmLeadRules\.uncontacted\)/);
  assert.match(DASH, /var staleLeads = leads\.filter\(uncontacted\);/);
  assert.doesNotMatch(DASH, /\(Date\.now\(\) - new Date\(l\.created_at\)\.getTime\(\)\) > DAY/, 'no hidden 1-day threshold any more');
});

t('#10 one lead-conversion source for the New leads tile and the Pipeline card', () => {
  const D = dashFns();
  const c = D.leadConv([{ quote_id: 'q' }, { status: 'won' }, { status: 'converted' }, { status: 'new' }, { status: 'lost' }]);
  assert.equal(c.n, 5); assert.equal(c.conv, 3); assert.equal(c.pct, 60);
  assert.equal(D.leadConv([]).pct, null);
  assert.match(DASH, /var lc = leadConv\(w\.items\);/);
  assert.match(DASH, /var allLc = leadConv\(leads\);/);
  assert.match(DASH, /leads became quotes \(" \+ allLc\.pct \+ "%\)"/);
  assert.match(DASH, /"All time\. "/, 'pipeline states its period');
  assert.match(DASH, /became quotes \(last " \+ dpName\(k\) \+ "\)"/, 'tile states its period');
});

t('#10 one "next event" for the hero countdown and the Upcoming tile', () => {
  assert.match(DASH, /var nextEv = null, nextBooked = false;/);
  assert.match(DASH, /var nx = nextEv;\n/);
  assert.match(DASH, /nx0 = nextEv;/);
  assert.match(DASH, /"Next event · not confirmed yet"/);
  assert.match(DASH, /nextBooked \? "Next booked: " : "Next \(not confirmed\): "/);
});

t('#30 countdown reads "45 days · starts 19:00" with its own classes (not the calendar .hd-cd)', () => {
  const cd = DASH.slice(DASH.indexOf('function countdown('), DASH.indexOf('/* ---------- Customize mode'));
  assert.match(cd, /"· starts " \+ hm\(\)/);   // r93: tm is {h, m} (tm[1]/tm[2] printed NaN:undefined)
  assert.match(cd, /cd === 1 \? "day" : "days"/);
  assert.doesNotMatch(cd, /"hd-cd"/, 'countdown no longer uses the calendar day class');
  assert.match(DCSS, /\.hd-count\.hd-cn \{ display: flex; flex-wrap: wrap; align-items: baseline;/);
});

t('#30 activity: display names via audit_actor_names, repeats grouped', () => {
  assert.match(DASH, /S\(\)\.audit\.actorNames \? S\(\)\.audit\.actorNames\(\)/);
  assert.match(DASH, /S\(\)\.audit\.actorLabel\(r, actNames\)/);
  assert.match(DASH, /if \(g && g\.key === key\) \{ g\.n\+\+;/);
  assert.match(DASH, /"×" \+ g\.n/);
});

t('#30 layout: customize bar / adopted cards get masonry rows; sample-data card joins the grid; All quotes can span', () => {
  assert.match(DASH, /mo\.observe\(dash, \{ childList: true \}\)/);
  assert.match(DASH, /\["obNudge", "tdCard", "tuCard"\]\.forEach/);
  assert.match(DASH, /qs\.classList\.toggle\("hd-span-all", full\)/);
  assert.match(DCSS, /\.hd-grid > \.hd-span-all \{ grid-column: 1 \/ -1; \}/);
});

t('#22/#30 mobile: Show tasks in flow, titles wrap, pill kept, equal 44px controls on touch', () => {
  assert.match(DCSS, /@media \(pointer: coarse\), \(max-width: 640px\) \{\n  html\[data-shell="b"\] \.hd-mw #mywork > \.pcard \{ padding-bottom: 14px; \}\n  html\[data-shell="b"\] \.hd-mw #mywork > \.pcard > \.ptoggle \{ position: static;/);
  assert.match(DCSS, /\.hd-tk-name \{ white-space: normal; display: -webkit-box;[^}]*-webkit-line-clamp: 2;/);
  assert.match(DCSS, /\.hd-ticket \.hd-tk-end \.hd-pill \{ display: inline-flex; font-size: 11px;/);
  assert.match(DCSS, /@media \(pointer: coarse\) \{\n  html\[data-shell="b"\] \.hd-btn, html\[data-shell="b"\] \.hd-btn\.hd-sm \{ min-height: 44px; height: auto; \}/);
});

t('#31 sidebar: labels fade in after the slide, compact rows on short windows, scroll hint', () => {
  assert.match(SCSS, /\.hb-rail:hover \.hb-lb[^{]+\{ transition: opacity \.16s var\(--hb-ease\) \.16s; \}/);
  assert.match(SCSS, /@media \(max-height: 760px\) and \(min-width: 820px\) \{\n  html\[data-shell="b"\] \.hb-scroll \.hb-item \{ height: 34px; \}/);
  assert.match(SCSS, /radial-gradient\(farthest-side at 50% 100%/);
});

t('#35 leads: breadcrumb cleared on close, inline checks on blur, maxlengths + budget max, short phone title', () => {
  assert.match(LEADS, /function closeDetail\(\)\{ \$\("#detailModal"\)\.hidden=true; detailId=null; try\{ if\(window\.HelmTrail&&HelmTrail\.clearCurrent\) HelmTrail\.clearCurrent\(\); \}/);
  assert.match(LEADS, /<script src="form-validate\.js\?v=\d+"><\/script>/);
  assert.match(LEADS, /HV\.bind\(\$\("#f_email"\),\{rule:"email"\}\)/);
  assert.match(LEADS, /HV\.bind\(\$\("#f_phone"\),\{rule:"phone",label:"Phone"\}\)/);
  assert.match(LEADS, /<input id="f_name" required maxlength="80"/);
  assert.match(LEADS, /<textarea id="f_notes" maxlength="2000"/);
  assert.match(LEADS, /<input id="f_budget" type="number" min="0" max="10000000000"/);
  assert.match(LEADS, /V\.money\(\$\("#f_budget"\)\.value,\{field:"Budget",max:10000000000\}\)/);
  assert.match(LEADS, /<small data-short="Leads">Leads &amp; Pipeline<\/small>/);
  assert.match(SHELL, /sm\.getAttribute\("data-short"\)/);
});

t('#35 the HelmValidate e-mail rule flags a bad address (what blur shows)', () => {
  const HV = require('../public/form-validate.js');
  assert.equal(HV.rules.email('not-an-email').ok, false);
  assert.equal(HV.rules.email('A@B.co').value, 'a@b.co');
  assert.equal(HV.rules.text('x'.repeat(81), { label: 'Contact name', max: 80 }).ok, false);
});

t('#36 nurture: emoji gap, label-ordered tabs, India default list, studio name in previews', () => {
  const T = require('../public/nurture-templates.js');
  const inKeys = T.primaryFor('IN').map((x) => x.key);
  assert.ok(!inKeys.includes('ramadan') && !inKeys.includes('eid') && !inKeys.includes('uae_national_day') && inKeys.includes('diwali'));
  assert.deepEqual(T.extrasFor('IN').map((x) => x.key), ['ramadan', 'eid']);
  assert.ok(T.primaryFor('AE').map((x) => x.key).includes('ramadan'), 'UAE keeps Ramadan by default');
  assert.ok(T.forCountry('IN').map((x) => x.key).includes('ramadan'), 'still available for India');
  assert.match(NUR, /<h2><span class="h-emo" aria-hidden="true">🎉<\/span>Occasions &amp; automation<\/h2>/);
  assert.match(NUR, /const byLabel=\(a,b\)=>tplLabel\(a\.occasion_type\)\.localeCompare\(tplLabel\(b\.occasion_type\)\);/);
  assert.match(NUR, /const TPL_OWN=\{ festival:"Festival", custom:"Custom" \};/);
  assert.match(NUR, /studio_name:STUDIO\.name\|\|""/);
  assert.match(NUR, /BPStore\.config\.getPricing\(\)/);
  assert.match(NUR, /groups\["More occasions"\]=extra;/);
});

t('#39 vendors: phone-input + inline validation loaded, ids escaped', () => {
  assert.match(VEND, /<script src="phone-input\.js\?v=\d+"><\/script>\n<script src="form-validate\.js\?v=\d+"><\/script>/);
  assert.match(VEND, /HV\.bind\(\$\("#v_phone"\),\{rule:"phone",label:"Phone"\}\)/);
  assert.match(VEND, /data-id="\$\{esc\(v\.id\)\}"/);
  assert.match(VEND, /data-edit="\$\{esc\(v\.id\)\}"/);
  assert.doesNotMatch(VEND, /placeholder="\+91…"/);
});

t('#42 routing: /<studio>/event and /<studio>/builder served (vercel + server.js), 404 helper redirects known pages', () => {
  const v = JSON.parse(read('vercel.json'));
  const rx = (s) => new RegExp('^' + s + '$');
  const dest = (p) => (v.rewrites || []).filter((r) => r.source !== '/i/:slug*' && rx(r.source).test(p)).map((r) => r.destination);
  assert.deepEqual(dest('/abcd/event'), ['/event']); assert.deepEqual(dest('/abcd/builder'), ['/builder']);
  assert.deepEqual(dest('/abcd'), [], 'bare slug is never rewritten (would catch every page)');
  const server = require('../server.js');
  assert.equal(server.prettyPage('/abcd/event'), 'event'); assert.equal(server.prettyPage('/abcd/builder'), 'builder');
  assert.equal(server.prettyPage('/abcd/event/x'), null);
  const nf = read('public/nf-studio.js');
  const run = (path, signedIn) => { let to = null; const ls = signedIn ? { 'sb-x-auth-token': '1' } : {};
    const ctx = { location: { pathname: path, search: '?id=Q1', hash: '', replace: (u) => { to = u; } },
      localStorage: { get length() { return Object.keys(ls).length; }, key: (i) => Object.keys(ls)[i], getItem: (k) => ls[k] } };
    vm.createContext(ctx); vm.runInContext(nf, ctx); return to; };
  assert.equal(run('/abcd/event.html', true), '/event?id=Q1');
  assert.equal(run('/abcd/builder', true), '/builder?id=Q1');
  assert.equal(run('/abcd', true), '/abcd/dashboard?id=Q1');
  assert.equal(run('/abcd/event.html', false), null, 'signed out: plain 404');
  assert.equal(run('/abcd/nonsense', true), null, 'unknown page: plain 404, no bounce');
});

console.log(`\nla-dashboard-misc: ${n} passed${failed ? ', ' + failed + ' FAILED' : ''}`);
if (failed) process.exit(1);
