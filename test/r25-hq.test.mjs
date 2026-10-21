// r25-hq.test.mjs - Helm HQ redesign (owner: "HQ looks boring"):
//  * shell: left sidebar (same tab buttons / ids), search across studios + people, page title
//  * Overview: KPI tiles from hq_metrics (0272) with a fallback to hq_overview, inline-SVG charts, needs attention,
//    system health, most active studios (numbers only)
//  * studio drawer with tabs; obvious "Change studio name & link"; Activity tab via hq_studio_usage
//  * Requests: count cards, tabs, row detail with the full message, "Reply by email" mailto (safe), status + note
//  * SQL 0272: read-only, _hq_gate, never a studio business table, APPLY verbatim + VERIFY, MANIFEST + run-all
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const rd = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const J = rd('public/hq.js'), H = rd('public/hq.html');
const SQL = rd('supabase/migrations/0272_hq_metrics.sql'), APPLY = rd('supabase/APPLY-0272.sql');
let n = 0;
const t = (name, fn) => { try { fn(); n++; console.log('  ok ' + name); } catch (e) { console.error('  FAIL ' + name + '\n' + (e && e.stack || e)); process.exitCode = 1; } };
function fnSrc(src, name) {
  const i = src.indexOf('function ' + name + '(');
  assert.ok(i >= 0, 'function ' + name + ' not found');
  let d = 0, j = src.indexOf('{', i);
  for (let k = j; k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}') { d--; if (d === 0) return src.slice(i, k + 1); } }
  throw new Error('unbalanced ' + name);
}
const cx = { encodeURIComponent, String, Number, Math, isFinite };
vm.createContext(cx);
vm.runInContext(['num', 'niceMax', 'shortInr', 'mailtoHref', 'monthLabel', 'weekLabel'].map((f) => fnSrc(J, f)).join('\n')
  + '\nthis.niceMax = niceMax; this.shortInr = shortInr; this.mailtoHref = mailtoHref; this.weekLabel = weekLabel;', cx);

t('shell: sidebar keeps every tab button + id, Requests badge, search box, page title, no inline handlers / styles', () => {
  for (const tb of ['overview', 'studios', 'billing', 'requests', 'plans', 'people', 'activity', 'staff'])
    assert.match(H, new RegExp(`<button type="button" class="tab" id="tab-${tb}" aria-pressed="(true|false)">`), tb);
  assert.match(H, /<aside class="side" aria-label="HQ menu">/);
  for (const id of ['navReqCount', 'gSearch', 'gResults', 'pageTitle', 'studioDrawer', 'studioScrim', 'btnDClose', 'reqCards', 'attList', 'health', 'tTop', 'cSign', 'cMrr', 'cMix', 'cFun'])
    assert.ok(H.includes(`id="${id}"`), id);
  assert.doesNotMatch(H, /\son[a-z]+=/i); assert.doesNotMatch(H, /\sstyle="/);
  assert.match(H, /<script src="hq\.js\?v=\d+"><\/script>/);
});
t('overview: hq_metrics with a fallback when 0272 is missing; tiles, charts, attention, health', () => {
  assert.match(J, /call\("hq_metrics"\)\.catch\(function \(\) \{ return null; \}\)/);
  assert.match(J, /renderOverview\(r\[0\] \|\| \{\}, r\[1\] && !Array\.isArray\(r\[1\]\) && r\[1\]\.studios \? r\[1\] : null\)/);
  for (const l of ['"Paying studios"', '"On free trial"', '"Trial → paid"', '"Open requests"', '"Failed e-mails (7 days)"', '"ARR "'])
    assert.ok(J.includes(l), l);
  assert.match(J, /Appears after SQL 0272 is applied/);
  assert.match(J, /document\.createElementNS\(SVGNS, tag\)/);
});
t('chart helpers: nice axis tops and short rupees', () => {
  assert.equal(cx.niceMax(0), 1); assert.equal(cx.niceMax(7), 10); assert.equal(cx.niceMax(11), 20); assert.equal(cx.niceMax(230), 250); assert.equal(cx.niceMax(4100), 5000);
  assert.equal(cx.shortInr(950), '₹950'); assert.equal(cx.shortInr(12500), '₹13K'); assert.equal(cx.shortInr(1500), '₹1.5K');
  assert.equal(cx.shortInr(320000), '₹3.2L'); assert.equal(cx.shortInr(11000000), '₹1.1Cr');
  assert.equal(cx.weekLabel('2026-10-19'), '19 Oct');
});
t('mailto: only a plain address; subject + greeting encoded; anything odd -> no link', () => {
  assert.equal(cx.mailtoHref('kavya@shaadisquad.in', 'Helm — your enquiry', 'Kavya Iyer'),
    'mailto:kavya@shaadisquad.in?subject=' + encodeURIComponent('Helm — your enquiry') + '&body=' + encodeURIComponent('Hi Kavya,\n\n'));
  for (const bad of ['', null, 'a@b', 'x@y.com?bcc=evil@z.com', 'x y@z.com', 'javascript:alert(1)', 'a@b.com&cc=c@d.com'])
    assert.equal(cx.mailtoHref(bad, 's', 'n'), null, String(bad));
});
t('studio drawer: tabs, obvious name & link button, identity + activate kept, activity via hq_studio_usage', () => {
  for (const d of ['overview', 'plan', 'people', 'ident', 'activity']) assert.ok(H.includes(`id="dt-${d}"`), d);
  assert.match(J, /text: "Change studio name & link"/);
  assert.match(J, /wrap\.appendChild\(identityBox\(org, d\)\);/);
  assert.match(J, /if \(sub\.status !== "suspended"( && can\("billing\.write"\))?\) wrap\.appendChild\(activateBox\(org, d\.name, sub\)\);/);
  assert.match(J, /call\("hq_studio_usage", \{ p_org: org \}\)/);
  assert.match(J, /if \(e\.key !== "Escape"\) return;/);
});
t('requests: tabs + counts + row detail with message, Reply by email, status buttons, note', () => {
  for (const id of ['rt-plan', 'rt-sales', 'rt-sugg', 'rt-alerts', 'rp-plan', 'rp-sales', 'rp-sugg', 'rp-alerts', 'rcPlan', 'rcSales', 'rcSugg']) assert.ok(H.includes(`id="${id}"`), id);
  assert.match(J, /text: "Reply by email"/);
  assert.match(J, /rowWithDetail\(tb, tr, 6, function \(td\)/);
  assert.match(J, /call\("hq_set_sales_request_status", \{ p_id: x\.id, p_status: k, p_note: note \|\| null \}\)/);
  assert.match(J, /rowActions\(x, SE_STATUS, "hq_set_sales_enquiry", loadSales\)/);
  assert.match(J, /rowActions\(x, SG_STATUS, "hq_set_suggestion", loadSuggestions\)/);
});
t('search: studios + people through the gated HQ RPCs only', () => {
  const f = fnSrc(J, 'runSearch');
  assert.match(f, /call\("hq_studios", \{ p_search: q, p_status: null, p_limit: 5, p_offset: 0 \}\)/);
  assert.match(f, /call\("hq_users", \{ p_search: q, p_limit: 5, p_offset: 0 \}\)/);
  assert.doesNotMatch(J, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(/);
});
t('SQL 0272: read-only, gated, never a studio business table, ASCII, APPLY verbatim + VERIFY, MANIFEST + run-all', () => {
  assert.ok(!/[^\x09\x0a\x0d\x20-\x7e]/.test(SQL) && !/[^\x09\x0a\x0d\x20-\x7e]/.test(APPLY), 'ASCII');
  const code = SQL.replace(/--.*$/gm, '');
  assert.match(code, /perform public\._hq_gate\('hq_metrics'\);/);
  assert.match(code, /perform public\._hq_gate\('hq_studio_usage', p_org::text\);/);
  assert.doesNotMatch(code, /^\s*(update|delete|truncate|insert|drop|alter)\b/im, 'no row / table change');
  assert.doesNotMatch(code, /\b(quotes|quote_payments|leads|clients|crew|crew_members|event_[a-z_]+|invitations|vendors|inventory_[a-z_]+|chat_[a-z_]+|member_profiles)\b/i);
  assert.doesNotMatch(code, /grant execute on function public\.hq_[a-z_]+\([^)]*\) to anon/);
  assert.ok(APPLY.includes(SQL.trim()), 'APPLY carries the migration verbatim');
  assert.match(APPLY, /^begin;$/m); assert.match(APPLY, /^commit;$/m); assert.match(APPLY, /^-- VERIFY/m);
  assert.match(rd('supabase/migrations/MANIFEST'), /^forward  supabase\/migrations\/0272_hq_metrics\.sql$/m);
  assert.match(rd('scripts/db-test/run-all.sh'), /tests\/db\/r25-hq-metrics-0272\.sql/);
});
console.log(`r25-hq: ${n} passed`);
