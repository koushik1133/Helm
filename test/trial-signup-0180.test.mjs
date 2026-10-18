// 0180: free-trial sign-up flow.
//  * sign-up never asks "demo data or own data": every trial is sample data, INR / Asia/Kolkata in every path
//  * the trial strip is only "Free trial - N days left" + "Choose a plan" (straight to /checkout)
//  * the 2-step welcome (and the tour after it) is driven by the server flag, so it shows on another device too
//  * the free-trial owner is not sent to /profile-setup first (server: my_profile_status)
//  * 0180 SQL: ASCII, additive, APPLY = migration + VERIFY, MANIFEST + run-all wired
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const TS = read('public/trial-signup.js'), TD = read('public/trial-demo.js'), TJ = read('public/trial.js');
const API = read('public/store-api.js'), AUI = read('public/auth-ui.js'), LOGIN = read('public/login.html'), DASH = read('public/dashboard.html');
const MIG = read('supabase/migrations/0180_trial_signup_flow.sql'), APPLY = read('supabase/APPLY-0180.sql');
let n = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); n++; console.log('ok -', name); } catch (e) { fail++; console.log('FAIL -', name); console.log(e && e.message); } };
const fnSrc = (src, name) => {
  const at = src.indexOf(`function ${name}(`); assert.ok(at >= 0, name + ' missing');
  let i = src.indexOf('{', src.indexOf(')', at)), depth = 0;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1); }
  throw new Error(name + ' unterminated');
};
const code = (s) => s.replace(/--.*$/gm, '');

// ---- sign-up: no choice, India only ----------------------------------------------------------------
await t('sign-up: no "demo or own data" card, start() always sends demo + India', () => {
  assert.ok(!/Start with my own data|How would you like to start\?|chooseStart|trialChoice|undoChoice/.test(TS), 'choice card removed');
  const b = fnSrc(TS, 'start');
  assert.match(b, /mode: "demo"/); assert.match(b, /timezone: loc\.timezone, currency: loc\.currency \}/);
  assert.match(fnSrc(TS, 'visitorLocale'), /timezone: TRIAL_TZ, currency: TRIAL_CUR/);
  assert.ok(!/\.tc-card|\.tc-opt|\.tc-tag/.test(LOGIN), 'dead choice-card CSS removed');
});
await t('localeFor: INR whatever the browser time zone', () => {
  const m = require('../public/trial-signup.js');
  for (const tz of ['America/Chicago', 'Asia/Dubai', 'Europe/London', 'Asia/Singapore', 'Australia/Sydney', 'Asia/Kolkata', '', undefined]) assert.equal(m.localeFor(tz), 'INR', String(tz));
  assert.equal(m.TRIAL_TZ, 'Asia/Kolkata'); assert.equal(m.TRIAL_CUR, 'INR');
});
await t('store-api: startSelfServe pins demo + Asia/Kolkata + INR on every path (also before 0119)', () => {
  const at = API.indexOf('async startSelfServe(o)'), b = API.slice(at, API.indexOf('\n      },', at));
  assert.match(b, /mode = "demo"/); assert.ok(!/o\.mode|o\.timezone|o\.currency/.test(b), 'no caller-supplied mode / locale');
  assert.match(b, /p_timezone: "Asia\/Kolkata", p_currency: "INR", p_mode: mode/);
  assert.match(b, /trialOrg\.start\(\{ timezone: "Asia\/Kolkata", currency: "INR" \}\)/);
  assert.match(b, /createStudio\(name, \{ currency: "INR", timezone: "Asia\/Kolkata" \}\)/);
  assert.ok(!/setMode\("own"\)/.test(b));
});
await t('login: the trial onboarding form hides currency / time zone / location and never writes the location', () => {
  assert.match(LOGIN, /if\(TRIAL\(\)\)\{ \$\("#ob_currency"\)\.value="INR"; \$\("#ob_tz"\)\.value="Asia\/Kolkata"; if\(lc\) lc\.hidden=true; \$\("#ob_location"\)\.hidden=true;/);
  assert.match(LOGIN, /const loc=TRIAL\(\)\? "" : \$\("#ob_location"\)\.value\.trim\(\);/);
  assert.match(LOGIN, /#onboardForm \[hidden\]\{display:none!important\}/);
});

// ---- banner ----------------------------------------------------------------------------------------
const tj = {}; vm.runInNewContext(fnSrc(TJ, 'bannerSpec').replace(/dayNo\(ymdIn\([^;]*;/, 'null;') + '\n' + fnSrc(TJ, 'planHref') +
  '\nglobalThis.spec=bannerSpec; globalThis.href=planHref;', tj);
const spec = (o) => JSON.parse(JSON.stringify(tj.spec(o)));
await t('trial strip: only "Free trial - N days left" + "Choose a plan"', () => {
  for (const mode of ['demo', 'own', null]) {
    const s = spec({ is_trial_org: true, is_admin: true, days_left: 6, trial_mode: mode });
    assert.equal(s.title, 'Free trial · 6 days left'); assert.equal(s.cta, 'Choose a plan');
    assert.equal(s.body, null); assert.ok(!('badge' in s) && !('fresh' in s), 'no badge / Start my own studio');
  }
  assert.equal(spec({ is_trial_org: true, is_admin: false, days_left: 1, trial_mode: 'demo' }).cta, null, 'members: no plan button');
  assert.equal(spec({ is_trial_org: true, is_admin: false, days_left: 1 }).title, 'Free trial · 1 day left');
  assert.ok(!/htr-badge|htr-fresh|spec\.fresh|spec\.badge|demo=fresh|exploring sample data/.test(TJ), 'render + CSS gone');
  // the ended state: 0183 shows it for a read-only (ended unpaid) studio; an ended date alone shows nothing
  assert.match(spec({ is_trial_org: true, is_admin: true, ended: true, read_only: true }).title, /trial has ended/);
  assert.equal(spec({ is_trial_org: true, is_admin: true, ended: true }), null);
});
await t('Choose a plan: straight to the plan / checkout page', () => {
  assert.equal(tj.href({ is_admin: true, trial_mode: 'demo' }, 'leads'), 'checkout.html?next=leads.html');
  assert.equal(tj.href({ is_admin: true, trial_mode: 'own' }, 'dashboard'), 'checkout.html?next=dashboard.html');
  assert.equal(tj.href(null, ''), 'checkout.html?next=dashboard.html');
  // an old cached link that asked to remove the samples first also lands on the plan page
  assert.match(TD, /if \(\/\[\?&\]demo=fresh\\b\/\.test\(q\) && \/\[\?&\]then=checkout\\b\/\.test\(q\)\) \{ global\.location\.assign\("checkout\.html\?next=dashboard\.html"\); return; \}/);
});
await t('during the trial: no sample-data card / "Start my own studio" on the dashboard, no demo notice', () => {
  assert.match(TD, /if \(dash\) render\(dash, inTrial && v === "demo" \? null : v, d, "dashboard", inTrial\);/);
  assert.match(TD, /if \(!inTrial\) row\.appendChild\(btn\("Start my own studio/);
  // QA B2: "in the trial" is the subscription's answer (any trial studio, not only a start_trial() one)
  assert.match(AUI, /if \(!onTrial\(t\)\) demoStatus\(t, d\);/);
});

// ---- welcome: server-driven -------------------------------------------------------------------------
const wd = {}; vm.runInNewContext(fnSrc(TD, 'welcomeDue') + '\n' + fnSrc(TD, 'welcomeShow') + '\nglobalThis.due=welcomeDue; globalThis.show=welcomeShow;', wd);
await t('welcomeShow: the server decides; the browser flag only before 0180 / for "again"', () => {
  const now = Date.now(), fresh = String(now - 1000), again = 'again:' + (now - 1000), old = String(now - 3 * 864e5);
  const A = { is_trial_org: true, is_admin: true };
  assert.equal(wd.show(A, true, null, now), true, 'server says pending: any device');
  assert.equal(wd.show(A, false, fresh, now), false, 'finished on another device: stale sign-up flag ignored');
  assert.equal(wd.show(A, false, again, now), true, 'asked again on this device');
  assert.equal(wd.show(A, null, fresh, now), true, '0180 not installed: sign-up flag');
  assert.equal(wd.show(A, null, old, now), false);
  assert.equal(wd.show(A, null, null, now), false);
  assert.equal(wd.show({ is_trial_org: true, is_admin: false }, true, fresh, now), false, 'members never');
  assert.equal(wd.show({ is_trial_org: false, is_admin: true }, true, fresh, now), false, 'paid never');
  assert.equal(wd.show(Object.assign({ ended: true }, A), true, fresh, now), false, 'ended trial');
  assert.equal(wd.show(null, true, fresh, now), false);
  assert.equal(wd.due(again, now), true); assert.equal(wd.due('again:x', now), false);
});

// a tiny DOM + BPStore to run trial-demo.js for real on the dashboard
function fakeEl(tag) {
  const e = { tagName: String(tag).toUpperCase(), children: [], attrs: {}, hidden: false, value: '', textContent: '', className: '', style: {},
    classList: { add() {}, remove() {} }, appendChild(c) { this.children.push(c); return c; }, insertBefore(c) { this.children.push(c); return c; },
    removeChild() {}, remove() { this.removed = true; }, setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; },
    getAttribute(k) { return this.attrs[k]; }, addEventListener(k, f) { (this.on = this.on || {})[k] = f; }, focus() {}, showModal() { this.open = true; },
    close() { this.open = false; }, querySelector() { return null; }, querySelectorAll() { return []; } };
  Object.defineProperty(e, 'firstChild', { get() { return null; } });
  return e;
}
async function runDash({ server, flag, trial, rpcLog }) {
  const ls = new Map(); if (flag != null) ls.set('bp_trial_welcome', flag);
  const body = fakeEl('body'), dialogs = [];
  const doc = { readyState: 'complete', body, createElement: (t) => { const e = fakeEl(t); if (t === 'dialog') dialogs.push(e); return e; },
    querySelector: () => null, querySelectorAll: () => [], getElementById: () => null, addEventListener() {} };
  const store = {
    init: async () => {},
    trialOrg: {
      status: async () => trial,
      welcomePending: async () => { rpcLog.push('my_trial_welcome_pending'); if (server instanceof Error) throw server; return server; },
      welcomeDone: async () => { rpcLog.push('trial_welcome_set:false'); return { result: 'ok' }; },
      welcomeAgain: async () => { rpcLog.push('trial_welcome_set:true'); return { result: 'ok' }; },
    },
  };
  const win = { document: doc, BPStore: store, location: { pathname: '/dashboard', search: '', assign() {}, replace(u) { win.replaced = u; } },
    localStorage: { getItem: (k) => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)), removeItem: (k) => ls.delete(k) },
    alert() {}, confirm() { return false; } };
  const ctx = vm.createContext({ window: win, globalThis: win, setTimeout, clearTimeout, Promise, console: { log() {}, warn() {}, error() {} } });
  vm.runInContext(TD.replace('(typeof window !== "undefined" ? window : globalThis)', '(window)'), ctx);
  const on = await win.HelmTrialDemo.welcomeDecision();
  await new Promise((r) => setTimeout(r, 20));
  return { on, ls, dialogs, win };
}
const trialAdmin = { is_trial_org: true, is_admin: true, name: 'Demo 7', trial_mode: 'demo', ended: false, locked: false };
await t('dashboard on another device (no browser flag): the server flag shows the welcome, tour held back', async () => {
  const rpcLog = [];
  const r = await runDash({ server: true, flag: null, trial: trialAdmin, rpcLog });
  assert.equal(r.on, true); assert.equal(r.win.HelmTrialDemo.welcomeOn, true, 'getter reflects the decision');
  assert.equal(r.dialogs.length, 1, 'welcome dialog mounted'); assert.equal(r.ls.get('bp_tour_autorun'), '1');
  assert.deepEqual(rpcLog, ['my_trial_welcome_pending']);
});
await t('welcome finished elsewhere: no welcome, old sign-up flag dropped, tour flag kept', async () => {
  const rpcLog = [];
  const r = await runDash({ server: false, flag: String(Date.now() - 5000), trial: trialAdmin, rpcLog });
  r.ls.set('bp_force_tour', '1');
  assert.equal(r.on, false); assert.equal(r.dialogs.length, 0); assert.equal(r.ls.has('bp_trial_welcome'), false);
  assert.equal(r.ls.get('bp_force_tour'), '1');
});
await t('before 0180 is installed (RPC missing -> null): the browser flag still works', async () => {
  const r = await runDash({ server: null, flag: String(Date.now() - 5000), trial: trialAdmin, rpcLog: [] });
  assert.equal(r.on, true); assert.equal(r.dialogs.length, 1);
});
await t('network error asking the server: falls back to the browser flag (no flag -> no welcome)', async () => {
  const a = await runDash({ server: new Error('offline'), flag: null, trial: trialAdmin, rpcLog: [] });
  assert.equal(a.on, false);
  const b = await runDash({ server: new Error('offline'), flag: String(Date.now() - 5000), trial: trialAdmin, rpcLog: [] });
  assert.equal(b.on, true);
});
await t('paid studio / member: the server is not even asked, no welcome', async () => {
  for (const tr of [{ is_trial_org: false, is_admin: true }, { is_trial_org: true, is_admin: false }, null]) {
    const rpcLog = [];
    const r = await runDash({ server: true, flag: String(Date.now()), trial: tr, rpcLog });
    assert.equal(r.on, false); assert.equal(r.dialogs.length, 0); assert.deepEqual(rpcLog, []);
  }
});
await t('finishing the welcome clears the server flag, then the tour runs on this device', () => {
  const b = fnSrc(TD, 'finishWelcome');
  assert.ok(b.indexOf('welcomeDone()') >= 0 && b.indexOf('welcomeDone()') < b.indexOf('location.replace'), 'server cleared before the reload');
  assert.match(b, /lsSet\("bp_force_tour", "1"\)/);
  const w = fnSrc(TD, 'toWelcome');
  assert.ok(w.indexOf('welcomeAgain()') >= 0 && w.indexOf('welcomeAgain()') < w.indexOf('location.assign'));
  assert.match(w, /"again:" \+ String\(Date\.now\(\)\)/);
});
await t('dashboard tour waits for the server decision (welcome first, then the tour)', () => {
  assert.match(DASH, /HelmTrialDemo\.welcomeDecision\(\)\.then\(v=>v===true, \(\)=>false\)/);
  assert.match(DASH, /if\(w !== false\) return;/);
  assert.ok(DASH.indexOf('welcomeDecision()') < DASH.indexOf('localStorage.removeItem("bp_force_tour")'), 'checked before the force flag is consumed');
});
await t('store-api: welcome RPC wrappers (null when 0180 is missing) + read-only RPC list', () => {
  assert.match(API, /welcomePending: \(\) => \(supa \? rpc\("my_trial_welcome_pending", \{\}\)\.then\(\(v\) => v === true, \(e\) => \{ if \(rpcMissing\(e\)\) return null; throw e; \}\)/);
  assert.match(API, /welcomeDone: \(\) => \(supa \? rpc\("trial_welcome_set", \{ p_pending: false \}\)/);
  assert.match(API, /welcomeAgain: \(\) => \(supa \? rpc\("trial_welcome_set", \{ p_pending: true \}\)/);
  assert.match(API, /\|admin_get_role_access\|my_trial_welcome_pending(?:\|[a-z_]+)*\)\(\\\?\|\$\)\/;/);   // la-fetch appends more read-only RPCs
  assert.ok(!/innerHTML|insertAdjacentHTML|\.style\./.test(TD), 'CSP-safe DOM');
});

// ---- 0180 SQL ---------------------------------------------------------------------------------------
await t('0180 SQL: ASCII, additive, same signatures, trial via _is_trial_org', () => {
  assert.ok(/^[\x00-\x7F]*$/.test(MIG) && /^[\x00-\x7F]*$/.test(APPLY), 'ASCII only');
  assert.ok(!/\b(drop\s+(table|column|function)|truncate|delete\s+from)\b/i.test(code(MIG)), 'nothing dropped / deleted');
  assert.match(MIG, /add column if not exists trial_welcome_pending boolean;/);
  assert.match(MIG, /create or replace function public\.start_self_serve_trial\(p_name text, p_timezone text, p_currency text, p_mode text\)/);
  const sst = MIG.slice(MIG.indexOf('function public.start_self_serve_trial'), MIG.indexOf('end $$;', MIG.indexOf('function public.start_self_serve_trial')));
  assert.match(sst, /v_tz text := 'Asia\/Kolkata'; v_cur text := 'INR';/); assert.match(sst, /v_mode text := 'demo';/);
  assert.ok(!/choose demo or own|pg_timezone_names/.test(sst)); assert.match(sst, /trial_welcome_pending = true/);
  const mps = MIG.slice(MIG.indexOf('function public.my_profile_status'));
  assert.match(mps, /v_p\.role = 'admin' and public\._is_trial_org\(v_p\.org_id\)/); assert.ok(!/trial_ends_at/.test(mps.slice(0, mps.indexOf('end $$;'))));
  assert.match(MIG, /revoke all on function public\.trial_welcome_set\(boolean\) from public, anon;/);
  assert.match(MIG, /revoke all on function public\.my_trial_welcome_pending\(\) from public, anon;/);
});
await t('APPLY-0180 = migration verbatim inside begin/commit + VERIFY; MANIFEST + run-all wired', () => {
  assert.ok(APPLY.includes(MIG), 'migration verbatim'); assert.match(APPLY, /^begin;$/m); assert.match(APPLY, /^commit;$/m);
  assert.ok(APPLY.indexOf('commit;') < APPLY.indexOf('-- VERIFY'), 'VERIFY after commit');
  assert.match(read('supabase/migrations/MANIFEST'), /^forward {2}supabase\/migrations\/0180_trial_signup_flow\.sql$/m);
  assert.match(read('scripts/db-test/run-all.sh'), /run "trial-signup-0180" "TRIAL-SIGNUP-0180: ALL PASS \\\(33\/33\\\)" psql -q -f tests\/db\/trial-signup-0180\.sql/);
});

if (fail) { console.log('trial-signup-0180: ' + fail + ' FAILED'); process.exit(1); }
console.log('trial-signup-0180: ' + n + ' passed');
