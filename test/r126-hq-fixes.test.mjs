// r126-hq-fixes.test.mjs - R126 HQ walkthrough fixes, front-end half + the SQL file's shape.
// Static + pure-function checks; the database side: tests/db/r126-hq-fixes-0335.sql; the real page in a browser with a
// mocked network: test/r126-hq-browser.harness.mjs (not in npm test, needs Chromium).
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
const rd = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const J = rd('public/hq.js'), H = rd('public/hq.html'), RS = rd('public/hq-responsive.css'), M = rd('public/hq-mfa.js'), API = rd('public/store-api.js'), AU = rd('public/auth-ui.js'), T = rd('public/page-tours.js');
const SQL = rd('supabase/migrations/0335_r126_hq_fixes.sql'), APPLY = rd('supabase/APPLY-0335.sql'), MF = rd('supabase/migrations/MANIFEST');
let n = 0;
const t = (name, fn) => { try { fn(); n++; console.log('  ok ' + name); } catch (e) { console.error('  FAIL ' + name + '\n' + (e && e.stack || e)); process.exitCode = 1; } };
function fnSrc(src, name) {
  const i = src.indexOf('function ' + name + '(');
  assert.ok(i >= 0, 'function ' + name + ' not found');
  let d = 0; const j = src.indexOf('{', i);
  for (let k = j; k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}') { d--; if (d === 0) return src.slice(i, k + 1); } }
  throw new Error('unbalanced ' + name);
}
const pure = (names, pre = '') => { const cx = { String, Number, isFinite, Math, Date, Error }; vm.createContext(cx);
  vm.runInContext(pre + names.map((x) => fnSrc(J, x)).join('\n') + '\n' + names.map((x) => 'this.' + x + ' = ' + x + ';').join('\n'), cx); return cx; };
const tableSrc = (name) => { const i = J.indexOf('var ' + name + ' = {'); assert.ok(i >= 0, name); return J.slice(i, J.indexOf('};', i) + 2); };
const NUM = 'function num(v) { var n = Number(v); return isFinite(n) ? n : 0; } function int(v) { return String(num(v)); }\n';

t('plural: 1 person, 2 people, 0 studios', () => {
  const c = pure(['plural'], NUM);
  assert.equal(c.plural(1, 'person', 'people'), '1 person'); assert.equal(c.plural(2, 'person', 'people'), '2 people'); assert.equal(c.plural(0, 'studio', 'studios'), '0 studios');
  assert.ok(!/int\(d\.users_count\) \+ " people"/.test(J));
});
t('job history says why, in plain words, for each reason', () => {
  const c = pure(['plural', 'cronWhy'], NUM);
  assert.match(c.cronWhy({ reason: 'not_installed' }), /not switched on/);
  assert.match(c.cronWhy({ reason: 'no_history', job_count: 1 }), /^1 job is set up/);
  assert.match(c.cronWhy({ reason: 'no_history', job_count: 3 }), /^3 jobs are set up/);
  assert.match(c.cronWhy({ reason: 'no_access', code: '42501' }), /refused.*42501/);
  assert.match(c.cronWhy({}), /can't be read/);
  assert.ok(!/isn.t readable/.test(J));
});
t('Needs attention uses the zone the database sends (the same day as the studio page)', () => {
  assert.match(J, /trial ends " \+ trialDay\(x\.ends_at, x\.timezone\)/);
  const c = pure(['date', 'trialDay']);
  // 19:30 UTC on 7 Nov is 8 Nov in India: the subscription's bare day said 7, the studio page said 8
  assert.equal(c.trialDay('2026-11-07T19:30:00+00:00', 'Asia/Kolkata'), '8 Nov 2026');
});
t('stored notes and "by" values never show a build number', () => {
  const c = pure(['plainText', 'plainBy']);
  assert.equal(c.plainText('First admin of the studio (0283).'), 'First admin of the studio.');
  assert.equal(c.plainBy('migration 0277'), 'Helm set-up'); assert.equal(c.plainBy('owner decision 0277b'), 'Helm set-up');
  assert.equal(c.plainBy('sales0123@helm.events'), 'sales0123@helm.events'); assert.equal(c.plainBy('Priya'), 'Priya');
  for (const w of ['x.invited_by', 'x.suspended_by', 'e.by', 'sgData.changed_by']) assert.ok(J.includes('plainBy(' + w + ')'), w);
  assert.ok(J.includes('plainText(h.reason)'));
});
t('activity log: plain words for What, no internal line under Action', () => {
  const c = pure(['auditWhat'], tableSrc('AUDIT_WHAT') + '\nvar UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;\n');
  const id = 'a0000000-0000-4000-8000-000000000001';
  assert.equal(c.auditWhat({ action: 'hq.view', entity: 'hq_studio_detail', entity_id: id, studio: 'Org A' }), 'Studio page · Org A');
  assert.equal(c.auditWhat({ action: 'hq.reveal', entity: 'member', entity_id: id, changed: { field: 'owner_email' } }), 'Studio member · owner email');
  assert.equal(c.auditWhat({ action: 'hq.view', entity: 'hq_billing', entity_id: '2026-11-01..2026-11-05' }), 'Billing · 2026-11-01 to 2026-11-05');
  assert.equal(c.auditWhat({ action: 'hq.view', entity: 'hq_users', entity_id: 'ka•••@studio.in' }), 'People list · search: ka•••@studio.in');
  assert.equal(c.auditWhat({ action: 'hq.view', entity: 'hq_studios', entity_id: 'mehndi|' }), 'Studios list · search: mehndi');
  assert.equal(c.auditWhat({ action: 'hq.x', entity: 'hq_new_thing' }), 'New thing');
  assert.ok(!/cls: "muted m", text: x\.action/.test(J));
});
t('every HQ log action in the migrations has plain words', () => {
  const words = tableSrc('ACT_WORDS');
  const { readdirSync } = process.getBuiltinModule('node:fs');
  const dir = new URL('../supabase/migrations/', import.meta.url), seen = new Set();
  for (const f of readdirSync(dir)) if (f.endsWith('.sql')) for (const m of readFileSync(new URL(f, dir), 'utf8').matchAll(/'(hq\.[a-z_]+(?:\.[a-z_]+)*)'/g)) seen.add(m[1]);
  const missing = [...seen].filter((a) => !words.includes('"' + a + '"'));
  assert.deepEqual(missing, []);
});
t('no developer wording on screen', () => {
  const screen = H.slice(H.indexOf('<body>'), H.lastIndexOf('<script src='));
  assert.ok(!/SQL \d{4}|migration \d{4}|\.md\b|R21-RESERVED|STAFF-GOOGLE|HQ v2 report/.test(screen));
  assert.ok(!/text: "[^"]*(SQL \d{4}|migration \d{4})/.test(J) && !/partFailed\(e, "/.test(J));
  assert.ok(!/config\.js mfaRequiredForAdmins/.test(M));
});
t('wording: Billing & plan, MRR, plans column, add credit, Suspend', () => {
  assert.ok(!H.includes('<b>Plan &amp; billing</b>'));
  assert.ok(!J.includes('from active plans') && J.includes('active + past-due plans'));
  assert.ok(!H.includes('prices shown in US dollars') && !H.includes('once SQL 0280') && H.includes('<th class="n">₹ price / month</th>'));
  assert.ok(J.includes('rs.length < 15') && !J.includes('(only voided)') && SQL.length > 0);
  assert.match(J, /Suspend " \+ \(d\.name[^\n]*Client links \(approval, portal, invitation, crew\) become read-only too/);
});
t('Record a payment says it does not renew; invoice settings call out the blanks', () => {
  assert.match(H, /This does not renew the studio/); assert.ok(J.includes('RECORD_ONLY'));
  const c = pure(['sellerGaps']);
  assert.deepEqual([...c.sellerGaps({ legal_name: 'Helm' })], ['the full legal name', 'GSTIN', 'address']);
  assert.equal(c.sellerGaps({ legal_name: 'Helm Events Pvt Ltd', gstin: '36ABCDE1234F1Z5', address: 'Hyderabad' }).length, 0);
  assert.match(H, /id="sellerWarn"/);
});
t('People: an HQ Owner never reads client; a person with no login never reads Active', () => {
  const c = pure(['roleWord']);
  assert.equal(c.roleWord({ role: 'client', org_id: null }), 'No studio yet'); assert.equal(c.roleWord({ role: 'HQ Owner' }), 'HQ Owner'); assert.equal(c.roleWord({ role: 'admin', org_id: 'x' }), 'admin');
  const d = pure(['teamStatus'], 'var S = null;\n');
  assert.equal(d.teamStatus({ status: 'active', has_login: false })[0], 'No login yet'); assert.equal(d.teamStatus({ status: 'active', has_login: true })[0], 'active');
});
t('HQ never asks the studio app: trial-lock, studio chrome and pricing stay off on hq + hq-referrals only', () => {
  const guard = /\/\^\\\/\(hq\|hq-referrals\)\(\\\.html\)\?\\\/\?\$\/\.test\(location\.pathname \|\| ""\)/g;
  assert.equal((API.match(guard) || []).length, 3);
  const re = /^\/(hq|hq-referrals)(\.html)?\/?$/;
  for (const p of ['/hq', '/hq.html', '/hq-referrals', '/hq-referrals.html']) assert.ok(re.test(p), p);
  for (const p of ['/hqstudio/dashboard', '/dashboard', '/hq-x', '/', '/control.html']) assert.ok(!re.test(p), p);
  assert.match(AU, /if \(hqPage\(\)\) return;[^\n]*\n\s*profileNudge\(\);\n\s*subscriptionStatus\(\);\n\s*trialStatus\(\);/);
  assert.match(AU, /if \(mfaReq\) adminTwoStep\(\);/);   // the two-step path is untouched
});
t('HQ still promises no client data, and the tours follow the changes', () => {
  assert.ok(H.includes('Never a studio’s clients, quotes or prices') && J.includes('Never a studio’s clients, quotes or prices'));
  assert.match(T, /Record a payment adds the payment and invoice only/); assert.match(T, /client logins are never listed/); assert.match(T, /job history can't be read/);
});
t('the owner-history line stacks instead of squeezing to one letter per line', () => {
  assert.ok(J.includes('cls: "list hist"')); assert.match(RS, /\.list\.hist li\{flex-direction:column/);
  assert.match(RS, /\.list li>\.m:first-child\{flex:1 1 160px/);
});
t('0335 is additive, in the manifest, and APPLY-0335 carries the same body', () => {
  assert.match(MF, /forward\s+supabase\/migrations\/0335_r126_hq_fixes\.sql/);
  assert.ok(!/\bdrop\s+(table|column|policy|trigger)\b|\bdelete\s+from\b|\btruncate\b|\bupdate\s+public\./i.test(SQL.replace(/^\s*--.*$/gm, '')));
  assert.ok(!/\bdrop\s+function\b/i.test(SQL.replace(/^\s*--.*$/gm, '')));
  assert.ok(APPLY.includes(SQL.trim())); assert.match(APPLY, /^begin;$/m); assert.match(APPLY, /^commit;$/m); assert.match(APPLY, /STOP 0335/);
  for (const s of [SQL, APPLY]) assert.ok(/^[\x00-\x7F]*$/.test(s), 'ASCII only');
  assert.ok(!/create temp|\\ir|\\set/.test(APPLY), 'paste-safe');
  assert.ok((SQL.match(/security definer set search_path = ''/g) || []).length >= 10);
  assert.ok(!/0334/.test(SQL.replace(/^\s*--.*$/gm, '')), 'needs nothing from 0334');
});
console.log(`r126-hq-fixes: ${n} passed`);
