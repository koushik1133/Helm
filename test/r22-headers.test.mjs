// r22 headers: page chrome clean-up (presentation only, no data calls changed).
//  1. Settings → Users & invites: the members table no longer squeezes the name to a few letters (photo + name +
//     "you" on one line, e-mail under it with ellipsis), Department sits under the job title, Edit / remove never clip,
//     two-line rows on a narrow card, cards on phones; every Settings card title has one style; room under the bar.
//  2. Calendar: "Calendar" once (top bar). The lonely breadcrumb row is gone and the card title is the month.
//  3. Insights: the intro spans the content width.
//  4. Every app page: a breadcrumb row that only repeats the page title is hidden (kept when it shows an open record),
//     duplicate page-title headings removed, one top gap under the top bar.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const CTL = read('public/control.html'), CSPL = read('public/control-split.css');
const SB = read('public/shell-b.js'), SBC = read('public/shell-b.css'), SBP = read('public/shell-b-pages.css');
const EVJ = read('public/events-calendar.js'), EVC = read('public/events-calendar.css');
const INS = read('public/insights-polish.css'), TRAIL = read('public/nav-trail.js');
const tests = []; const t = (n, f) => tests.push([n, f]);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function fnSrc(src, name) {
  const i = src.indexOf('function ' + name + '('); assert.ok(i >= 0, name);
  let d = 0; for (let k = src.indexOf('{', i); k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}' && !--d) return src.slice(i, k + 1); }
  throw new Error('unbalanced ' + name);
}
function ucTable() {
  const ctx = { esc };
  vm.runInNewContext('const ucId=(u)=>u.user_id||u.id;' + ['ucDate', 'ucShownName', 'ucNameHtml', 'ucPhone', 'ucInitials', 'ucPrivateVisible', 'ucMatches', 'ucTable']
    .map((f) => fnSrc(CTL, f)).join('\n') + '\nglobalThis.T=ucTable;', ctx);
  return ctx.T;
}
const ROW = (i, o) => Object.assign({ id: 'u' + i, email: 'person' + i + '@studio.test', full_name: 'Person ' + i, role: 'crew', phone: '+919876543210',
  job_title: 'Rigger', department: 'Production', complete: true, created_at: '2026-09-01', whatsapp_same: true }, o || {});

/* ---------------------------------------------------------------- 1. Settings members table */
t('members table: name cell = photo + (name + "you") line + e-mail line with a full-address tooltip', () => {
  const T = ucTable();
  const r = T([ROW(1, { full_name: 'S Koushik', email: 'shagantikoushik@gmail.com', role: 'admin' }), ROW(2)],
    { profiles: true, meId: 'u1', roles: ['admin', 'crew'], roleLabel: (x) => x, canEdit: true, q: '', filter: '' });
  assert.match(r.body, /<td class="dn" data-label="Name"><div class="ucwho"><span class="ucav"[^>]*>SK<\/span><div class="ucwt"><div class="ucnm"><span class="dnTxt">S Koushik<\/span> <span class="me">you<\/span><\/div><div class="ucsub em" title="shagantikoushik@gmail\.com">shagantikoushik@gmail\.com<\/div><\/div><\/div><\/td>/);
  assert.equal((r.body.match(/<span class="me">you<\/span>/g) || []).length, 1);
});
t('members table: Department under the job title (one column), labelled cells, Edit + remove in one actions cell', () => {
  const T = ucTable();
  const r = T([ROW(1), ROW(2, { job_title: '', department: '' })], { profiles: true, meId: 'u1', roles: ['crew'], canEdit: true, q: '', filter: '' });
  assert.equal(r.head, '<tr><th scope="col">Name</th><th scope="col">Phone</th><th scope="col">Job title</th><th scope="col">Role</th><th scope="col">Profile</th><th scope="col"><span class="sr-only">Actions</span></th></tr>');
  assert.doesNotMatch(r.head, /Department/);
  assert.match(r.body, /<td class="ucjob" data-label="Job title">Rigger<div class="ucsub ucdept">Production<\/div><\/td>/);
  assert.match(r.body, /<td class="ucjob" data-label="Job title">—<\/td>/, 'no empty department line');
  for (const c of ['ucph" data-label="Phone"', 'ucrole" data-label="Role"', 'ucprof" data-label="Profile"']) assert.match(r.body, new RegExp('<td class="' + c));
  assert.match(r.body, /<td class="ucact"><button type="button" class="btn sm ucEdit"[^>]*>Edit<\/button><button type="button" class="rm"/);
  assert.match(r.body, /<tr class="ucr" data-id="u1">/);
  const np = T([ROW(1), ROW(2, { whatsapp_same: null })], { profiles: true, meId: 'u1', roles: ['crew'], q: '', filter: '' });
  assert.match(np.body, /<tr class="ucr ucr-np" data-id="u1">/, 'no-phone rows get their own compact grid');
  assert.match(T([], { profiles: true, meId: 'u1', roles: [], q: '', filter: '' }).body, /colspan="5"/);
  assert.match(T([ROW(1)], { profiles: true, meId: 'u9', roles: [], q: 'nobody', filter: '' }).body, /colspan="6"/);
});
t('members table CSS: no per-letter wrapping, sensible widths, compact rows on a narrow card, cards on phones', () => {
  assert.match(CTL, /<div class="table-scroll ucm-wrap"><table class="utable ucm"><thead id="um_head">/);
  assert.match(CTL, /\.ucm-wrap\{container:ucm\/inline-size\}/);
  assert.match(CTL, /\.utable\.ucm td\.dn\{width:34%;min-width:210px;white-space:normal\}/);
  assert.match(CTL, /\.ucnm\{display:flex;align-items:center;gap:6px;min-width:0;white-space:nowrap\}/);
  assert.match(CTL, /\.ucwt \.ucsub\{overflow:hidden;text-overflow:ellipsis;white-space:nowrap\}/);
  assert.match(CTL, /\.utable\.ucm td\.ucrole select\{width:136px;max-width:100%\}/);
  assert.match(CTL, /\.utable\.ucm td\.ucact\{white-space:nowrap;/);
  assert.match(CTL, /@media \(min-width:640px\)\{\n    @container ucm \(max-width:859\.98px\)\{/);
  assert.match(CTL, /grid-template-areas:"who who role prof act" "ph job job job job"/);
  assert.match(CTL, /#pane-users \.utable\.ucm\.tm-stack td\{width:auto;min-width:0;max-width:none;border-bottom:0\}/);
  // the B29 rules that caused "S Kous hik" no longer reach the members table (older Name / Email table keeps them)
  assert.match(CSPL, /#app\.cs-on \.cs-main \.utable:not\(\.ucm\) td\.dn\{white-space:normal;overflow-wrap:anywhere;min-width:12ch\}/);
  assert.doesNotMatch(CSPL, /#app\.cs-on \.cs-main \.utable td\.ucact\{white-space:normal\}/);
  assert.doesNotMatch(CSPL, /#app\.cs-on \.cs-main \.utable td\.em\{overflow-wrap:anywhere/);
});
t('Settings: wider settings layout, one card-title style, page gap under the top bar', () => {
  assert.match(CTL, /\.wrap\{max-width:1240px;margin:0 auto;padding:0 24px 60px\}/);
  assert.match(CSPL, /#app\.cs-on:not\(\[hidden\]\)\{display:grid;grid-template-columns:232px minmax\(0,1fr\);[^}]*max-width:1180px/);
  assert.match(CSPL, /#app\.cs-on \.cs-main \.card > h3,#app\.cs-on \.cs-main \.card > \.cx-head h3\{[^}]*text-transform:none;letter-spacing:-\.005em/);
  assert.match(SBP, /html\[data-shell="b"\]:not\(\[data-dash\]\) body > \.wrap > main#main \{ padding-top: 20px; \}/);
});
t('Settings: ids and wiring the page script uses are unchanged', () => {
  for (const id of ['um_head', 'um_rows', 'uc_q', 'uc_f', 'uc_count', 'uc_tools', 'um_add', 'um_email', 'um_role', 'inv_rows'])
    assert.equal((CTL.match(new RegExp('id="' + id + '"', 'g')) || []).length, 1, id);
  assert.match(CTL, /tb\.querySelectorAll\("\.ucEdit"\)\.forEach/);
  assert.match(CTL, /tb\.querySelectorAll\("\.roleSel"\)\.forEach/);
  assert.match(CTL, /tb\.querySelectorAll\("\.dnEdit"\)\.forEach/);
});

/* ---------------------------------------------------------------- 2. Calendar */
t('calendar: the month is the card title; "Events calendar" stays for screen readers only', () => {
  assert.match(EVJ, /<h2 id="evcTitle"><span class="evc-sr">Events calendar: <\/span><span class="evc-range" id="evcRange" aria-live="polite"><\/span><\/h2>/);
  assert.doesNotMatch(EVJ, /<h2 id="evcTitle">Events calendar<\/h2>/);
  assert.match(EVJ, /\$\("#evcRange"\)\.textContent = label\(rg\);/, 'month label still written to #evcRange');
  assert.match(EVC, /\.evc-range\{display:block;margin:0;font-size:20px;font-weight:700/);
  assert.match(EVC, /\.evc-head\{display:flex;flex-wrap:wrap;align-items:center;/);
});

/* ---------------------------------------------------------------- 3. Insights */
t('insights: the intro line is not capped at 72ch', () => {
  assert.match(INS, /main p\.ins-intro\.sub \{[^}]*max-width: none; \}/);
  assert.match(read('public/insights.html'), /<p class="sub ins-intro"><b>How we’re doing over time:<\/b> trends per event &amp; team for the dates you pick — events, money, costs, and where things slip\.<\/p>/);
});

/* ---------------------------------------------------------------- 4. every page: trail, duplicate titles, top gap */
function trailEnv(path, liCount) {
  const classes = new Set(), rootCls = new Set();
  const cl = (s) => ({ contains: (c) => s.has(c), toggle: (c, on) => { if (on) s.add(c); else s.delete(c); } });
  const trail = { classList: cl(classes), querySelectorAll: () => ({ length: liCount }) };
  const window = { location: { pathname: path } };
  const document = { readyState: 'loading', addEventListener() {}, getElementById: (id) => (id === 'helmTrail' ? trail : null), documentElement: { classList: cl(rootCls) } };
  window.document = document;
  const api = (new Function('module', 'globalThis', 'window', TRAIL + '\nreturn window.HelmTrail;'))({}, window, window);
  window.HelmTrail = api;
  const src = fnSrc(SB, 'trailBase') + '\n' + fnSrc(SB, 'trailTidy') + '\ntrailTidy();';
  new Function('window', 'document', src)(window, document);
  return { lone: classes.has('hb-trail-lone'), has: rootCls.has('hb-has-trail') };
}
t('trail: a row that only repeats the page is hidden; a row with an open record stays', () => {
  assert.deepEqual(trailEnv('/calendar.html', 1), { lone: true, has: false }, '"Calendar"');
  assert.deepEqual(trailEnv('/insights.html', 2), { lone: true, has: false }, '"Reports / Insights"');
  assert.deepEqual(trailEnv('/settlement.html', 2), { lone: true, has: false }, '"Quotes / Settlement"');
  assert.deepEqual(trailEnv('/settlement.html', 3), { lone: false, has: true }, '"Quotes / SMP-1004 · Kapoor Family Sangeet / Settlement"');
  assert.deepEqual(trailEnv('/event.html', 2), { lone: false, has: true }, '"Quotes / SMP-1004 · Kapoor Family Sangeet"');
  assert.deepEqual(trailEnv('/leads.html', 2), { lone: false, has: true }, '"Leads / <lead name>"');
  assert.deepEqual(trailEnv('/acme-events/events/abc', 1), { lone: false, has: true }, 'pretty event URL: the record name alone is context');
  assert.match(SBC, /html\[data-shell="b"\] #helmTrail\.hb-trail-lone \{ display: none !important; \}/);
  assert.match(SB, /safe\(trailWatch\);/);
  assert.match(SB, /trailObs = new MutationObserver\(trailTidy\); trailObs\.observe\(tr, \{ childList: true, subtree: true \}\);/);
});
t('pages: no heading that repeats the top-bar title', () => {
  assert.doesNotMatch(read('public/crm.html'), /<h2>CRM<\/h2>/);
  assert.doesNotMatch(read('public/vendors.html'), /<h2>Vendors &amp; partners<\/h2>/);
  assert.doesNotMatch(read('public/reports.html'), /<h2>Reports &amp; exports<\/h2>/);
  assert.doesNotMatch(read('public/audit.html'), /<h2>Audit log<\/h2>/);
  assert.doesNotMatch(read('public/integrations.html'), /<h2>Integrations<\/h2>/);
  // the top bar still names each page
  for (const [f, h] of [['crm', 'CRM Archive'], ['vendors', 'Vendors &amp; Partners'], ['reports', 'Reports &amp; exports'], ['audit', 'Audit log'], ['integrations', 'Integrations']]) {
    const s = read('public/' + f + '.html');
    assert.ok(s.includes('<h1>' + h + '</h1>') || s.includes('<small>' + h + '</small>'), f);
  }
});
t('pages: one top gap under the top bar (dashboard + chat keep their own layout)', () => {
  assert.match(SBP, /html\[data-shell="b"\]\.hb-has-trail:not\(\[data-dash\]\) body > \.wrap > main#main \{ padding-top: 14px; \}/);
  assert.match(SBP, /body > \.wrap > main#main > \.toolbar:first-child \{ margin-top: 0; \}/);
  assert.doesNotMatch(SBP, /body:is\(:has\(#arrRows\), :has\(#openBadge\)\) \.wrap > main#main \{ padding-top: 20px; \}/, 'the issues/command one-off is now the general rule');
  assert.doesNotMatch(read('public/chat.html'), /<main id="main"/, 'chat is a full-height app (main#app), untouched');
});

let n = 0;
for (const [name, fn] of tests) { try { await fn(); n++; } catch (e) { console.error('✗ ' + name); throw e; } }
console.log('r22-headers: ' + n + ' tests passed');
