// 0076 pass: date-ranged Insights + Reports, Insights in the profile menu, plain-words audit log
// and quote activity trail. Pure helpers are run in a VM; pages are checked statically.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const API = read('public/store-api.js'), AUI = read('public/auth-ui.js');
const INS = read('public/insights.html'), REP = read('public/reports.html'), AUD = read('public/audit.html'), FLOW = read('public/flow.html');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok -', name); };
const fnSrc = (src, name) => {
  const at = src.indexOf(`function ${name}(`); assert.ok(at >= 0, name + ' missing');
  let i = src.indexOf('{', src.indexOf(')', at)), depth = 0;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1); }
  throw new Error(name + ' unterminated');
};
const constSrc = (src, name) => { const at = src.indexOf(`const ${name} =`); assert.ok(at >= 0, name); return src.slice(at, src.indexOf(';\n', at) + 1); };
const ctx = {};
vm.runInNewContext([constSrc(API, 'AUDIT_AREA_LABELS'), constSrc(API, 'AUDIT_CLIENT_ACTIONS'), constSrc(API, 'RANGE_PRESETS'),
  ...['auditHuman', 'auditAreaLabel', 'auditActionLabel', 'auditEventText', 'auditDescribe', 'auditWho', 'activityText', 'rangeFor', 'rangeCheck', 'inRange'].map((f) => fnSrc(API, f)),
  'globalThis.X={auditAreaLabel,auditActionLabel,auditDescribe,auditWho,activityText,rangeFor,rangeCheck,inRange};'].join('\n'), ctx);
const X = ctx.X;
const J = (v) => JSON.parse(JSON.stringify(v));

t('ranges: presets on a fixed day', () => {
  const d = new Date(2026, 9, 8);   // 8 Oct 2026
  assert.deepEqual(J(X.rangeFor('this_month', d)), { from: '2026-10-01', to: '2026-10-31' });
  assert.deepEqual(J(X.rangeFor('last_month', d)), { from: '2026-09-01', to: '2026-09-30' });
  assert.deepEqual(J(X.rangeFor('last_30', d)), { from: '2026-09-09', to: '2026-10-08' });
  assert.deepEqual(J(X.rangeFor('last_60', d)), { from: '2026-08-10', to: '2026-10-08' });
  assert.deepEqual(J(X.rangeFor('last_90', d)), { from: '2026-07-11', to: '2026-10-08' });
  assert.deepEqual(J(X.rangeFor('this_year', d)), { from: '2026-01-01', to: '2026-12-31' });
  assert.deepEqual(J(X.rangeFor('last_month', new Date(2026, 0, 15))), { from: '2025-12-01', to: '2025-12-31' });
  assert.equal(X.rangeFor('custom', d), null);
});
t('ranges: custom validation + inRange', () => {
  assert.deepEqual(J(X.rangeCheck('2026-01-01', '2026-02-01')), { from: '2026-01-01', to: '2026-02-01' });
  assert.equal(X.rangeCheck('2026-02-01', '2026-01-01'), null);
  assert.equal(X.rangeCheck('2026-02-30', '2026-03-01'), null);
  assert.equal(X.rangeCheck('', '2026-03-01'), null);
  assert.equal(X.rangeCheck('2026-1-1', '2026-03-01'), null);
  const r = { from: '2026-05-01', to: '2026-05-31' };
  assert.equal(X.inRange('2026-05-31T23:00:00Z', r), true); assert.equal(X.inRange('2026-06-01', r), false);
  assert.equal(X.inRange('', r), false); assert.equal(X.inRange('anything', null), true);
});
t('audit: views are never "Deleted"; friendly sentences with event code', () => {
  const evs = { q1: { code: 'W-0012', title: 'Sharma wedding' } };
  assert.equal(X.auditDescribe({ action: 'booklet.view', entity: 'client_booklets', quote_id: 'q1' }, evs), 'Client viewed the booklet for W-0012 · Sharma wedding');
  assert.equal(X.auditDescribe({ action: 'booklet.share', quote_id: 'q1', changed: { expires_at: '2026-11-01T00:00:00Z' } }, evs),
    'Booklet shared with the client for W-0012 · Sharma wedding (link valid until 2026-11-01)');
  assert.match(X.auditDescribe({ action: 'booklet.snapshot', changed: { kind: 'snapshot_3d', set: false } }, {}), /^3D snapshot removed in the booklet$/);
  assert.match(X.auditDescribe({ action: 'booklet.snapshot', changed: { kind: 'snapshot_3d', set: true } }, {}), /3D snapshot updated/);
  assert.equal(X.auditDescribe({ action: 'hq.plan.upsert' }, {}), 'Hq plan upsert');
  assert.equal(X.auditDescribe({ action: 'update', changed: {} }, {}), null);    // keeps the field diff
  assert.equal(X.auditDescribe({ action: 'profile.update' }, {}), null);
  assert.doesNotMatch(X.auditDescribe({ action: 'pkg.view', quote_id: 'zz' }, evs), /Deleted|zz/);
  assert.equal(X.auditActionLabel('booklet.view'), 'Viewed'); assert.equal(X.auditActionLabel('delete'), 'Deleted');
  assert.equal(X.auditAreaLabel('client_booklets'), 'Client booklet'); assert.equal(X.auditAreaLabel('some_new_table'), 'Some new table');
});
t('audit: who = name, else e-mail, else Client (link actions) / System', () => {
  const names = { u1: { full_name: 'Ravi  Kumar', email: 'ravi@a.test' } };
  assert.deepEqual(J(X.auditWho({ actor: 'u1', actor_email: 'ravi@a.test' }, names)), { text: 'Ravi Kumar', title: 'ravi@a.test' });
  assert.equal(X.auditWho({ actor: null, action: 'booklet.view' }, {}).text, 'Client');
  assert.equal(X.auditWho({ actor: null, action: 'quote.moved_to_archive' }, {}).text, 'System');
  assert.equal(X.auditWho({ actor: 'u9', actor_email: 'x@y.z' }, {}).text, 'x@y.z');
});
t('activity trail: raw kinds become plain words with names', () => {
  assert.equal(X.activityText({ kind: 'notify', text: 'advance_paid → email' }, { clientName: 'Priya' }), 'Payment received — receipt sent to Priya by e-mail');
  assert.equal(X.activityText({ kind: 'notify', text: 'pkg_payment → ' }, {}), 'Package payment received');
  assert.equal(X.activityText({ kind: 'notify', text: 'payment_link → p@x.in' }, { clientName: 'Priya' }), 'Payment link sent to Priya (p@x.in) by e-mail');
  assert.equal(X.activityText({ kind: 'notify', text: 'some_new_kind → whatsapp' }, {}), 'Some new kind on WhatsApp');
  assert.match(X.activityText({ kind: 'payment', text: 'Payment R-7 — 5000 (cash)' }, { clientName: 'Priya' }), /^Payment received from Priya — ₹5,000 by cash \(receipt R-7\)$/);
  assert.match(X.activityText({ kind: 'payment', text: 'Payment created — 2500' }, {}), /^Payment link created — ₹2,500$/);
  assert.equal(X.activityText({ kind: 'version', text: 'Layout v2' }, {}), 'Layout v2');
  assert.match(FLOW, /BPStore\.activityText\(a,\{clientName:/);
});
t('insights: gated on the insights area, range bar, server RPC, money only with finance', () => {
  assert.match(API, /\{ key: "insights",\s+label: "Insights"/);
  assert.match(API, /rpc\("insights_range", \{ p_from: from \|\| null, p_to: to \|\| null \}\)/);
  assert.match(INS, /BPStore\.auth\.canView\("insights"\)/);
  assert.doesNotMatch(INS, /\["admin","manager","planner"\]\.includes\(role\)/);
  assert.match(INS, /HelmRange\.mount\(\$\("#rangeBar"\)/); assert.match(INS, /range-bar\.js\?v=1/);
  assert.match(INS, /if\(canFin && m\)/); assert.match(INS, /BPStore\.insights\.summary\(\{from:r\.from,to:r\.to\}\)/);
  assert.doesNotMatch(INS, /style="/); assert.doesNotMatch(read('public/range-bar.js'), /innerHTML|style=|\.style\./);
});
t('reports: same range bar; exports filtered; inventory unfiltered', () => {
  assert.match(REP, /HelmRange\.mount\(\$\("#rangeBar"\)/);
  assert.match(REP, /BPStore\.insights\.summary\(range\)/);
  assert.match(REP, /async events\(\)\{ const a=\(await BPStore\.quotes\.list\(\)\)\.filter\(e=>inR\(evDay\(e\)\)\)/);
  assert.doesNotMatch(REP, /\.style\.display/);
});
t('profile menu: Insights only when canView(insights) === true; Reports/Audit stay in Control Center', () => {
  assert.match(fnSrc(AUI, 'menuModel'), /if \(canInsights === true\) items\.push\(\{ id: "insights", label: "Insights", href: "insights\.html" \}\)/);
  assert.match(AUI, /canView\("insights"\)/);
  assert.match(read('public/control.html'), /<a href="reports\.html">Reports<\/a><a href="audit\.html">Audit log<\/a>/);
  assert.match(AUD, /BPStore\.audit\.describe\(r,events\)/); assert.match(AUD, /BPStore\.audit\.eventLabels\(need\)/);
});
t('SQL 0076: additive, ASCII, gated, in MANIFEST; APPLY ends with verify rows', () => {
  const mig = read('supabase/migrations/0076_insights.sql'), ap = read('supabase/APPLY-0076.sql');
  assert.match(read('supabase/migrations/MANIFEST'), /forward  supabase\/migrations\/0076_insights\.sql/);
  [mig, ap].forEach((s) => {
    assert.doesNotMatch(s, /[^\x00-\x7F]/); assert.doesNotMatch(s, /\b(drop table|delete from|truncate|update public\.|insert into)\b/i);
    assert.doesNotMatch(s, /create temp/i); assert.match(s, /set search_path = ''/); assert.match(s, /has_area\('insights', 'view'\)/);
  });
  assert.match(ap.trim(), /select item, ok from \(values[\s\S]*\) v\(item, ok\)\norder by item;$/);
});
console.log(`\ninsights-audit: ${n} passed`);
