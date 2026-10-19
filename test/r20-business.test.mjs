// r20-business.test.mjs - owner r20: "By default the Business page should be seen only by the admin, not by
// anyone else. Insights too - admin only. Later studios can adjust it."
//  * a NEW matrix area 'business' (Control Center -> Roles & access), no defaultOn -> admin only until switched on
//  * the Business nav item, the page gate (business.js), the search entries and the dashboard payment strip
//    follow 'business', not 'finance' (planners keep finance for payments / settlement / closure)
//  * 0239: existing studios get the rows insert-only, new studios via the 0049 default matrix, the two Business-only
//    RPCs (vendor_payables_summary, business_pnl) also need has_area('business'), shared RPCs untouched
//  * insights: admin only by default in the AREAS list and in the server default matrix
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log('  ✓ ' + name); } catch (e) { fail++; console.log('  ✗ ' + name + '\n    ' + (e && e.stack || e)); } };

const STORE = read('public/store-api.js');
// the AREAS list + coarse map, evaluated as written
const areasSrc = /const AREAS = (\[[\s\S]*?\n  \]);/.exec(STORE)[1];
const AREAS = vm.runInNewContext('(' + areasSrc + ')');
const coarseSrc = /const COARSE_TO_FINE = (\{[\s\S]*?\n  \});/.exec(STORE)[1];
const COARSE = vm.runInNewContext('(' + coarseSrc + ')');
const ROLES = vm.runInNewContext(/const ALL_ROLES  = (\[[^\]]*\]);/.exec(STORE)[1]);

// the same rules as BPStore.auth.canView (store-api.js): admin always; else the studio's row; no row = off
function canView(role, rows, area) {
  if (role === 'admin') return true;
  const fine = COARSE[area];
  if (fine) return fine.some((k) => rows[k] && rows[k].view);
  return !!(rows[area] && rows[area].view);
}
// Control Center: a cell with no saved row shows the area's defaultOn (control.html cellDefault)
const cellDefault = (role, key) => { const a = AREAS.find((x) => x.key === key); const on = !!(a && a.defaultOn && a.defaultOn.includes(role)); return { view: on, edit: on }; };
// a planner as the server default matrix (0049) sets it: finance / settlement / closure / quotes on
const PLANNER = { finance: { view: true, edit: true }, settlement: { view: true, edit: true }, closure: { view: true, edit: true }, quotes: { view: true, edit: true } };

await t('AREAS: a separate "business" area in the Admin group, no page link, no defaultOn (admin only)', () => {
  const b = AREAS.find((a) => a.key === 'business');
  assert.ok(b, 'business area listed'); assert.equal(b.group, 'Admin'); assert.equal(b.page, null);
  assert.match(b.label, /Business overview/); assert.ok(!b.defaultOn, 'no role on by default');
  assert.ok(!Object.values(COARSE).some((l) => l.includes('business')), 'not folded into a coarse key (finance stays separate)');
  for (const r of ROLES) if (r !== 'admin') assert.equal(cellDefault(r, 'business').view, false, r + ' off by default in Control Center');
});

await t('defaults: admin sees Business; planner (finance on) / coordinator / manager do not; the switch grants it', () => {
  assert.equal(canView('admin', {}, 'business'), true);
  assert.equal(canView('planner', PLANNER, 'finance'), true, 'planner keeps finance');
  assert.equal(canView('planner', PLANNER, 'settlement'), true);
  assert.equal(canView('planner', PLANNER, 'business'), false, 'planner: no Business page');
  assert.equal(canView('coordinator', { quotes: { view: true } }, 'business'), false);
  assert.equal(canView('manager', Object.assign({}, PLANNER, { controls: { view: true, edit: true } }), 'business'), false);
  assert.equal(canView('planner', Object.assign({}, PLANNER, { business: { view: true, edit: false } }), 'business'), true, 'switched on in Control Center');
  // the 0239 seed row for a non-admin is off: same as no row
  assert.equal(canView('planner', Object.assign({}, PLANNER, { business: { view: false, edit: false } }), 'business'), false);
});

await t('insights: admin only by default (no defaultOn in AREAS; not in the server default matrix)', () => {
  const i = AREAS.find((a) => a.key === 'insights'); assert.ok(i && !i.defaultOn);
  for (const r of ROLES) if (r !== 'admin') assert.equal(cellDefault(r, 'insights').view, false, r);
  const M49 = read('supabase/migrations/0049_db_gates.sql'), M = read('supabase/migrations/0239_business_area_admin_only.sql');
  for (const src of [M49, M]) {
    const body = /function public\._a49_default_matrix\(\)[\s\S]*?\$\$;/.exec(src)[0];
    assert.ok(!/'insights'/.test(body), 'insights not in the default matrix');
  }
  assert.match(read('supabase/migrations/0076_insights.sql'), /No role_access rows are seeded/);
});

await t('business page: gated on canView("business"); no-access panel otherwise; vendor payables mount waits on it', async () => {
  const js = read('public/business.js');
  assert.match(js, /await A\.canView\("business"\)/); assert.ok(!/canView\("finance"\)/.test(js), 'no finance gate left');
  const html = read('public/business.html');
  assert.match(html, /id="noaccess"[\s\S]*Business overview/); assert.match(html, /data-vb-mount="business" data-vb-gate="bzApp"/);
  // run the page bootstrap with a stubbed DOM / BPStore for an admin, a planner and a planner with the switch on
  async function boot(role, rows) {
    const nodes = {}; const node = (id) => (nodes[id] = nodes[id] || { hidden: true, firstChild: null, appendChild() {}, removeChild() {} });
    let mounted = false, asked = [];
    const BPStore = { init: async () => {}, bell: { mount: async () => {} }, auth: {
      enabled: () => true, required: () => true, user: () => ({ email: role + '@x.test' }), role: async () => role, signOut: async () => {},
      canView: async (a) => { asked.push(a); return canView(role, rows, a); } } };
    const ctx = { BPStore, document: { readyState: 'complete', querySelector: (s) => node(s.replace('#', '')), createElement: () => ({ appendChild() {}, addEventListener() {} }), addEventListener() {} },
      location: { replace() {}, href: '' }, window: { HelmMoney: { mount: async () => { mounted = true; } } }, HelmUrl: { here: () => 'business.html' }, encodeURIComponent };
    ctx.window.BPUI = null;
    vm.createContext(ctx); vm.runInContext(js, ctx);
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    return { mounted, app: !nodes.bzApp || nodes.bzApp.hidden === false, noaccess: nodes.noaccess && nodes.noaccess.hidden === false, asked };
  }
  const a = await boot('admin', {}); assert.equal(a.mounted, true); assert.equal(a.noaccess, undefined);
  const p = await boot('planner', PLANNER); assert.equal(p.mounted, false, 'planner: page not mounted'); assert.equal(p.noaccess, true, 'planner: no-access panel');
  assert.deepEqual(p.asked, ['business', 'insights']);   // release/r20-pr4: r20 planner also asks "insights" for the header link
  const c = await boot('coordinator', { quotes: { view: true } }); assert.equal(c.mounted, false); assert.equal(c.noaccess, true);
  const on = await boot('planner', Object.assign({}, PLANNER, { business: { view: true } })); assert.equal(on.mounted, true, 'switched on: page opens');
});

await t('nav + search: Business item / search entries follow "business", not finance', async () => {
  const SB = read('public/shell-b.js');
  assert.match(SB, /Promise\.resolve\(BPStore\.auth\.canView\("business"\)\)[\s\S]{0,900}item\("business", "Business", "business\.html", "business"\)/);
  assert.ok(!/canView\("finance"\)\)[\s\S]{0,900}item\("business"/.test(SB), 'no finance gate on the nav item');
  assert.match(read('public/shell-b-search.js'), /id: "go-business"[^\n]*need: \[\["view", "business"\]\]/);
  const CAT = require('../public/search-catalog.js');
  const who = (role, rows) => ({ role: async () => role, canView: async (a) => canView(role, rows, a) });
  const txt = async (role, rows) => (await CAT.entriesFor(who(role, rows), {}, { trial: false })).map((e) => e.text);
  assert.ok((await txt('admin', {})).includes('Business'), 'admin finds Business');
  assert.ok(!(await txt('planner', PLANNER)).includes('Business'), 'planner does not');
  assert.ok((await txt('planner', Object.assign({}, PLANNER, { business: { view: true } }))).includes('Business'), 'switched on: found');
});

await t('dashboard: payment strip links to Business only for roles with it (quotes list or plain text otherwise)', () => {
  const D = read('public/shell-b-dash.js');
  assert.match(D, /var vBiz = !signedOut && \(await canView\("business"\)\);/);
  assert.match(D, /var bizHref = vBiz \? "business\.html" : vQuotes \? "quotes\.html" : null;/);
  assert.ok(!/: "business\.html", IC\./.test(D), 'no hard-coded business.html fallback left');
  assert.equal((D.match(/: bizHref, IC\.(alert|cal)/g) || []).length, 2, 'overdue + due-today strips');
  assert.match(D, /var a = href \? link\(href, cls\) : el\("span", cls\);/, 'no link when the role can open neither page');
});

await t('0239 SQL: additive + idempotent, guards, insert-only seed, wrappers, shared RPCs untouched', () => {
  const M = read('supabase/migrations/0239_business_area_admin_only.sql'), A = read('supabase/APPLY-0239.sql');
  const code = M.replace(/^\s*--.*$/gm, '');
  assert.ok(!/[^\x00-\x7F]/.test(M) && !/[^\x00-\x7F]/.test(A), 'ASCII only');
  assert.match(M, /REQUIRES/); assert.match(M, /ROLLBACK/);
  assert.ok(!/\b(delete\s+from|truncate|drop\s+(table|column|policy)|update\s+public\.)/i.test(code), 'no delete / truncate / drop / update');
  assert.ok(!/create\s+(temp|temporary)\s+table|set_config\(|\bset\s+(local\s+)?(?!search_path)[a-z_]+\s*=/i.test(code), 'no temp tables / session state');
  assert.match(code, /insert into public\.role_access[\s\S]*?'business', r\.role = 'admin', r\.role = 'admin'[\s\S]*?on conflict \(org_id, role, area\) do nothing;/);
  assert.match(code, /raise exception 'STOP: [^']*' *;|raise exception 'STOP:/);
  assert.match(code, /498843f8c0669cf38703f30824776d86/, 'default-matrix drift guard');
  assert.match(code, /\('business',   '\{\}',\s+'\{\}'\)\)/, 'business in the default matrix for nobody but admin');
  for (const f of ['vendor_payables_summary', 'business_pnl']) {
    assert.match(code, new RegExp(`if to_regprocedure\\('public\\.${f}__pre0239\\([^)]*\\)'\\) is null then\\s+alter function public\\.${f}\\([^)]*\\) rename to ${f}__pre0239;`), f + ' renamed once');
    assert.match(code, new RegExp(`create or replace function public\\.${f}\\([^)]*\\)[\\s\\S]*?has_area\\('business', 'view'\\)[\\s\\S]*?return public\\.${f}__pre0239\\(`), f + ' wrapper');
    assert.match(code, new RegExp(`revoke all on function public\\.${f}__pre0239\\([^)]*\\) from authenticated`), f + ' kept body not callable');
  }
  for (const f of ['dashboard_money', 'dashboard_due_today', 'event_pnl', 'record_vendor_payout', 'record_settlement_payment', 'has_area('])
    assert.ok(!new RegExp('function public\\.' + f.replace('(', '\\(')).test(code), f + ' not touched');
  // APPLY = header + begin + the migration + commit + VERIFY rows
  assert.ok(A.includes('begin;\n' + M) && /\ncommit;\n/.test(A), 'APPLY wraps the canonical file');
  assert.equal((A.match(/^  \('0\d /gm) || []).length, 7, '7 VERIFY rows');
  const man = read('supabase/migrations/MANIFEST');
  assert.match(man, /\nforward  supabase\/migrations\/0239_business_area_admin_only\.sql\n/);
  assert.ok(man.indexOf('0238_trial_quotes_cap_two.sql') < man.indexOf('0239_business_area_admin_only.sql'));
  assert.match(read('scripts/db-test/run-all.sh'), /run "r20-business-0239" "R20-BUSINESS-0239: ALL PASS \\\(34\/34\\\)" psql -q -f tests\/db\/r20-business-0239\.sql/);
  assert.match(read('tests/db/r20-business-0239.sql'), /\\ir \.\.\/\.\.\/supabase\/migrations\/0239_business_area_admin_only\.sql[\s\S]*\\ir \.\.\/\.\.\/supabase\/migrations\/0239_business_area_admin_only\.sql/, 'DB suite runs it twice');
});

console.log(`r20-business: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
