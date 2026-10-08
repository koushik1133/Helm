// hq-mfa.test.mjs — Helm HQ sign-in requires two-step verification (TOTP, aal2).
//  * platform operator WITHOUT a verified authenticator → forced set-up (no skip)
//  * operator WITH one, session still aal1           → the 6-digit code step
//  * operator at aal2                                 → HQ loads
//  * non-operators: unchanged (fake 404 on /hq; their authenticators are never read)
//  * wrong-code lockout + generic errors
// Runs the real public/store-api.js + public/hq.js in a vm sandbox with a stub
// Supabase client that mimics is_platform_admin()'s server rule (aal2 required once
// the account has a verified factor). No network, no real credentials.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const root = new URL('..', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
const STORE = read('public/store-api.js');
const HQ = read('public/hq.js');
const LOGIN = read('public/login.html');
const tests = [];
const t = (name, fn) => tests.push([name, fn]);

function memStore(init) {
  const m = new Map(Object.entries(init || {}));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _m: m };
}
function elStub(id) {
  const e = { id, hidden: id === 'vApp' || id === 'vNotFound', textContent: '', value: '', style: {}, attrs: {}, children: [], disabled: false,
    setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k]; }, appendChild(c) { this.children.push(c); return c; },
    removeChild() {}, get firstChild() { return null; }, addEventListener() {}, scrollIntoView() {}, remove() {}, querySelector: () => null,
    classList: { add() {}, remove() {}, contains: () => false } };
  return e;
}
function makeEnv(o = {}) {
  const calls = [];
  const user = o.user === null ? null : (o.user || { id: 'op-1', email: 'admin@helm.events' });
  let aal = o.aal || 'aal1';
  const srv = o.srv || { fails: 0, until: 0 };
  let factors = (o.factors || []).map((f) => Object.assign({ factor_type: 'totp' }, f));
  let session = user ? { user, access_token: 'x' } : null;
  const verified = () => factors.filter((f) => f.factor_type === 'totp' && f.status === 'verified');
  const client = {
    auth: {
      async getSession() { return { data: { session } }; },
      onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; },
      async refreshSession() { return { data: { session }, error: session ? null : { message: 'no' } }; },
      async signOut() { session = null; return { error: null }; },
      mfa: {
        async getAuthenticatorAssuranceLevel() { calls.push(['aal']); return { data: { currentLevel: aal, nextLevel: verified().length ? 'aal2' : aal }, error: null }; },
        async listFactors() {
          calls.push(['listFactors']);
          if (o.factorsError) return { data: null, error: { message: 'Failed to fetch' } };
          return { data: { all: factors, totp: verified() }, error: null };
        },
        async enroll() { calls.push(['enroll']); const f = { id: 'f-new', factor_type: 'totp', status: 'unverified' }; factors.push(f); return { data: { id: f.id, totp: { qr_code: '<svg></svg>', secret: 'S' } }, error: null }; },
        async unenroll({ factorId }) { factors = factors.filter((f) => f.id !== factorId); return { error: null }; },
        async challengeAndVerify({ factorId, code }) {
          calls.push(['verify', code]);
          if (o.rateLimited) return { error: { message: 'Too many requests', status: 429 } };
          if (code !== '123456') return { error: { message: 'Invalid TOTP code entered', status: 422, code: 'mfa_verification_failed' } };
          const f = factors.find((x) => x.id === factorId); if (f) f.status = 'verified';
          aal = 'aal2'; return { error: null };
        },
      },
    },
    async rpc(name) {
      calls.push(['rpc', name]);
      if (name === 'is_platform_admin') return { data: !!o.operator && (verified().length ? aal === 'aal2' : true), error: null };
      if (name === 'password_change_required') return { data: false, error: null };
      if (name === 'current_org_id') return { data: o.org || null, error: null };
      if (name === 'operator_mfa_required') return o.flagError ? { data: null, error: { message: 'Failed to fetch' } } : { data: o.mfaOptional ? false : true, error: null };
      if (/^hq_/.test(name)) return { data: name === 'hq_overview' ? {} : [], error: null };
      // 0050 server-side lockout (shared server state: o.srv survives a "reload" / other tab)
      if (/^mfa_(lock_status|record_failure|record_success)$/.test(name) && o.noLockRpc) return { data: null, error: { code: 'PGRST202', message: 'not found' } };
      if (name === 'mfa_lock_status' || name === 'mfa_record_failure') {
        const sv = srv; const now = Date.now();
        if (sv.until && sv.until <= now) { sv.until = 0; sv.fails = 0; }
        if (name === 'mfa_record_failure' && !(sv.until > now)) { sv.fails++; if (sv.fails >= 5) sv.until = now + 900000; }
        return { data: { locked: sv.until > now, retry_after: sv.until > now ? Math.ceil((sv.until - now) / 1000) : 0, fails: sv.fails }, error: null };
      }
      if (name === 'mfa_record_success') { if (aal === 'aal2') { srv.fails = 0; srv.until = 0; return { data: true, error: null }; } return { data: false, error: null }; }
      return { data: null, error: null };
    },
    from() { const q = { select: () => q, eq: () => q, order: () => q, single: async () => ({ data: { role: 'admin' }, error: null }) }; return q; },
  };
  const els = {};
  const $ = (sel) => { const id = String(sel).replace(/^#/, ''); return (els[id] = els[id] || elStub(id)); };
  const loc = { pathname: o.path || '/hq', search: '', hash: '', origin: 'https://www.helm.events', href: '', hostname: 'www.helm.events',
    replace(u) { calls.push(['location.replace', u]); }, reload() { calls.push(['location.reload']); } };
  const doc = {
    readyState: 'complete', title: '', addEventListener() {}, removeEventListener() {}, currentScript: { src: 'https://www.helm.events/store-api.js?v=1' },
    createElement: (tag) => elStub(tag), createElementNS: (ns, tag) => elStub(tag), createTextNode: (s) => ({ text: s }),
    head: { appendChild() {} }, body: elStub('body'),
    documentElement: { setAttribute() {}, getAttribute() { return 'light'; }, classList: { contains: () => false, add() {}, remove() {} } },
    querySelector: $, querySelectorAll: () => [], getElementById: (id) => $(id),
  };
  const win = {
    SUPABASE_CONFIG: { url: 'https://abcdefghijklmnopqrst.supabase.co', anonKey: 'anon' },
    supabase: { createClient: () => client },
    localStorage: memStore(o.ls), sessionStorage: memStore(), location: loc, document: doc, navigator: { onLine: true },
    fetch: async () => ({ ok: false, status: 503, json: async () => ({}) }),
    addEventListener() {}, removeEventListener() {},
    setTimeout: (fn, ms) => { if (!ms || ms < 1000) { try { fn(); } catch (e) {} } return 0; }, clearTimeout() {},
    setInterval: () => 0, clearInterval() {},
    atob: (b) => Buffer.from(b, 'base64').toString('binary'),
    console: { log() {}, info() {}, warn() {}, error() {} },
  };
  win.window = win; win.globalThis = win;
  vm.createContext(win);
  vm.runInContext(STORE, win, { filename: 'store-api.js' });
  return {
    win, S: win.BPStore, calls, els,
    loadHq: () => vm.runInContext(HQ, win, { filename: 'hq.js' }),
    replaced: () => calls.filter((c) => c[0] === 'location.replace').map((c) => c[1]),
    rpcs: () => calls.filter((c) => c[0] === 'rpc').map((c) => c[1]),
    listed: () => calls.some((c) => c[0] === 'listFactors'),
    hqCalls: () => calls.filter((c) => c[0] === 'rpc' && /^hq_/.test(c[1])).map((c) => c[1]),
  };
}
const flush = async (n = 12) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const VERIFIED = [{ id: 'f-1', status: 'verified' }];

/* ------------------------------------------- 1. store-api decision */
t('decision table: no factor → enroll · factor + aal1 → challenge · factor + aal2 → ok', () => {
  const d = makeEnv({ user: null }).S.auth.mfa._operatorDecision;
  assert.equal(d({ currentLevel: 'aal1' }, 0), 'enroll');
  assert.equal(d({ currentLevel: 'aal2' }, 0), 'enroll', 'aal2 without a verified factor still has to enrol');
  assert.equal(d({ currentLevel: 'aal1' }, 1), 'challenge');
  assert.equal(d(null, 1), 'challenge', 'unknown level fails closed');
  assert.equal(d({ currentLevel: 'aal2' }, 1), 'ok');
});
t('operator WITHOUT a factor → "enroll"', async () => {
  const e = makeEnv({ operator: true });
  await e.S.init();
  assert.equal(e.S.auth.pendingStep(), null);
  assert.equal(await e.S.auth.mfa.operatorStep(), 'enroll');
});
t('operator WITH a factor at aal1 → "challenge" (sign-in step pending; is_platform_admin not even asked)', async () => {
  const e = makeEnv({ operator: true, factors: VERIFIED, aal: 'aal1' });
  await e.S.init();
  assert.equal(e.S.auth.pendingStep(), 'mfa');
  assert.equal(await e.S.auth.mfa.operatorStep(), 'challenge');
  assert.ok(!e.rpcs().includes('is_platform_admin'));
});
t('operator WITH a factor at aal2 → "ok"', async () => {
  const e = makeEnv({ operator: true, factors: VERIFIED, aal: 'aal2' });
  await e.S.init();
  assert.equal(await e.S.auth.mfa.operatorStep(), 'ok');
});
t('non-operator → "none", and their authenticators are never read', async () => {
  for (const o of [{}, { factors: VERIFIED, aal: 'aal2' }, { org: 'org-1' }]) {
    const e = makeEnv(Object.assign({ user: { id: 'u-1', email: 'planner@studio.test' } }, o));
    await e.S.init();
    assert.equal(await e.S.auth.mfa.operatorStep(), 'none');
    assert.equal(e.listed(), false, 'listFactors must not be called for a non-operator');
  }
});
t('operator whose factors cannot be read → "unknown" (fail closed)', async () => {
  const e = makeEnv({ operator: true, factorsError: true });
  await e.S.init();
  assert.equal(await e.S.auth.mfa.operatorStep(), 'unknown');
});
t('enrol + first code → aal2 → "ok" → operatorToHq() sends the browser to HQ', async () => {
  const e = makeEnv({ operator: true, path: '/login' });
  await e.S.init();
  assert.equal(await e.S.auth.mfa.operatorStep(), 'enroll');
  const r = await e.S.auth.mfa.enrollTotp();
  await e.S.auth.mfa.verify(r.factorId, '123 456');
  assert.equal(await e.S.auth.mfa.operatorStep(), 'ok');
  assert.equal(await e.S.auth.operatorToHq(), true);
  assert.deepEqual(e.replaced(), ['/hq']);
});
t('challenge with the right code → aal2 → "ok"', async () => {
  const e = makeEnv({ operator: true, factors: VERIFIED, aal: 'aal1', path: '/login' });
  await e.S.init();
  await e.S.auth.mfa.challenge('123456');
  assert.equal(e.S.auth.pendingStep(), null);
  assert.equal(await e.S.auth.mfa.operatorStep(), 'ok');
});

/* ------------------------------------------------ 2. hq.js routing */
const shown = (e, id) => e.els[id] && e.els[id].hidden === false;
t('hq.js: operator without a factor → sign-in page (forced set-up there); no HQ data requested', async () => {
  const e = makeEnv({ operator: true });
  e.loadHq(); await flush();
  assert.deepEqual(e.replaced(), ['login.html']);
  assert.deepEqual(e.hqCalls(), []);
  assert.ok(!shown(e, 'vApp'));
});
t('hq.js: operator with a factor at aal1 → sign-in page (code step); no HQ data, no factor read', async () => {
  const e = makeEnv({ operator: true, factors: VERIFIED, aal: 'aal1' });
  e.loadHq(); await flush();
  assert.deepEqual(e.replaced(), ['login.html']);
  assert.deepEqual(e.hqCalls(), []);
  assert.equal(e.listed(), false);
  assert.ok(!shown(e, 'vApp'));
});
t('hq.js: operator at aal2 → HQ shown and loaded', async () => {
  const e = makeEnv({ operator: true, factors: VERIFIED, aal: 'aal2' });
  e.loadHq(); await flush();
  assert.deepEqual(e.replaced(), []);
  assert.ok(e.hqCalls().includes('hq_overview'));
  assert.ok(shown(e, 'vApp'));
  assert.ok(!shown(e, 'vNotFound'));
});
t('hq.js: non-operator → the ordinary 404 (no redirect, no HQ data, factors never read)', async () => {
  for (const o of [{}, { factors: VERIFIED, aal: 'aal2' }]) {
    const e = makeEnv(Object.assign({ user: { id: 'u-1', email: 'planner@studio.test' } }, o));
    e.loadHq(); await flush();
    assert.deepEqual(e.replaced(), []);
    assert.deepEqual(e.hqCalls(), []);
    assert.ok(shown(e, 'vNotFound'));
    assert.ok(!shown(e, 'vApp'));
    assert.equal(e.listed(), false);
  }
});
t('hq.js: operator whose factors cannot be read → sign-in page, never HQ', async () => {
  const e = makeEnv({ operator: true, factorsError: true });
  e.loadHq(); await flush();
  assert.deepEqual(e.replaced(), ['login.html']);
  assert.deepEqual(e.hqCalls(), []);
});
/* ------------------------------------------------ 0047: two-step optional switch */
t('0047 switch off: operator without a factor → "ok" (no forced set-up) and HQ opens', async () => {
  const e = makeEnv({ operator: true, mfaOptional: true, path: '/login' });
  await e.S.init();
  assert.equal(await e.S.auth.mfa.operatorStep(), 'ok');
  const h = makeEnv({ operator: true, mfaOptional: true });
  h.loadHq(); await flush();
  assert.deepEqual(h.replaced(), []);
  assert.ok(h.hqCalls().includes('hq_overview'));
  assert.ok(shown(h, 'vApp'));
});
t('0047 switch off: operator WITH a factor at aal1 is still asked for the code', async () => {
  const e = makeEnv({ operator: true, mfaOptional: true, factors: VERIFIED, aal: 'aal1', path: '/login' });
  await e.S.init();
  assert.equal(await e.S.auth.mfa.operatorStep(), 'challenge');
});
t('0047 switch unreadable → treated as required (fail closed: set-up forced)', async () => {
  const e = makeEnv({ operator: true, flagError: true, path: '/login' });
  await e.S.init();
  assert.equal(await e.S.auth.mfa.operatorStep(), 'enroll');
});
t('login.html: BPUI.boot only covers init — the interactive sign-in steps run after it (no endless spinner)', () => {
  const html = readFileSync(new URL('../public/login.html', import.meta.url), 'utf8');
  const m = html.match(/BPUI\.boot\(async \(\)=>\{([\s\S]*?)\n  \}\)/);
  assert.ok(m, 'boot block found');
  assert.ok(!/finishGate|routeSignedIn|operatorTwoStep|askMfaCode|operatorEnroll/.test(m[1]), 'boot must not await user-driven steps');
  assert.match(html, /\.then\(\(resume\)=>\{ if\(resume===true\) resumeSession\(\); \}\)/);
});
t('hq.js: signed out → sign-in page', async () => {
  const e = makeEnv({ user: null });
  e.loadHq(); await flush();
  assert.deepEqual(e.replaced(), ['login.html']);
  assert.deepEqual(e.hqCalls(), []);
});

/* ----------------------------------------- 3. wrong codes / lockout */
t('wrong code: one generic message (server text never shown), no lock before 5 tries', async () => {
  const e = makeEnv({ operator: true, factors: VERIFIED, aal: 'aal1', path: '/login' });
  await e.S.init();
  for (let i = 1; i <= 4; i++) {
    await assert.rejects(e.S.auth.mfa.challenge('000000'), (err) => {
      assert.equal(err.code, 'mfa_invalid');
      assert.ok(!/Invalid TOTP|mfa_verification/i.test(err.message), 'server detail leaked: ' + err.message);
      assert.match(err.message, /30 seconds/);
      return true;
    });
  }
  assert.equal(e.S.auth.mfa.lockedSeconds(), 0);
});
t('5 wrong codes → locked ON THE SERVER for 15 min (right code refused without asking Auth); another tab/reload sees it; aal2 success clears', async () => {
  const srv = { fails: 0, until: 0 };
  const e = makeEnv({ operator: true, factors: VERIFIED, aal: 'aal1', path: '/login', srv });
  await e.S.init();
  for (let i = 1; i <= 4; i++) await assert.rejects(e.S.auth.mfa.challenge('000000'), (err) => err.code === 'mfa_invalid');
  await assert.rejects(e.S.auth.mfa.challenge('000000'), (err) => err.code === 'mfa_locked' && err.retryAfter >= 899 && /wait 15 minutes/.test(err.message));
  assert.equal(e.calls.filter((c) => c[0] === 'rpc' && c[1] === 'mfa_record_failure').length, 5, 'each wrong code recorded on the server');
  const before = e.calls.filter((c) => c[0] === 'verify').length;
  await assert.rejects(e.S.auth.mfa.challenge('123456'), (err) => err.code === 'mfa_locked');
  assert.equal(e.calls.filter((c) => c[0] === 'verify').length, before, 'no Auth verify while locked');
  assert.ok(e.S.auth.mfa.lockedSeconds() > 0);
  assert.equal(e.win.localStorage.getItem('bp_mfa_lock'), null, 'nothing kept in localStorage');
  // a fresh tab / reload (new store instance, same server state) is still locked
  const e2 = makeEnv({ operator: true, factors: VERIFIED, aal: 'aal1', path: '/login', srv });
  await e2.S.init();
  assert.equal(e2.S.auth.mfa.lockedSeconds(), 0, 'nothing local');
  assert.ok((await e2.S.auth.mfa.refreshLock()) > 0, 'server lock visible to the new tab');
  await assert.rejects(e2.S.auth.mfa.challenge('123456'), (err) => err.code === 'mfa_locked');
  // the lock ends → correct code → server counter cleared (at aal2)
  srv.until = Date.now() - 1;
  const e3 = makeEnv({ operator: true, factors: VERIFIED, aal: 'aal1', path: '/login', srv });
  await e3.S.init();
  await e3.S.auth.mfa.challenge('123456');
  assert.deepEqual([srv.fails, srv.until], [0, 0]);
  assert.ok(e3.calls.some((c) => c[0] === 'rpc' && c[1] === 'mfa_record_success'));
});
t('server lockout functions missing (0050 not applied) → per-tab fallback: 5 wrong → 60 s pause', async () => {
  const e = makeEnv({ operator: true, factors: VERIFIED, aal: 'aal1', path: '/login', noLockRpc: true });
  await e.S.init();
  for (let i = 0; i < 4; i++) await assert.rejects(e.S.auth.mfa.challenge('000000'), (err) => err.code === 'mfa_invalid');
  await assert.rejects(e.S.auth.mfa.challenge('000000'), (err) => err.code === 'mfa_locked' && err.retryAfter >= 59 && err.retryAfter <= 60);
  assert.equal(e.win.localStorage.getItem('bp_mfa_lock'), null);
});
t('server rate limit (429) → the same lockout message', async () => {
  const e = makeEnv({ operator: true, factors: VERIFIED, aal: 'aal1', path: '/login', rateLimited: true });
  await e.S.init();
  await assert.rejects(e.S.auth.mfa.challenge('123456'), (err) => err.code === 'mfa_locked' && !/Too many requests/.test(err.message));
});

/* ---------------------------------------------- 4. login.html wiring */
t('login.html: operators pass two-step BEFORE the HQ hand-off; studio users route exactly as before', () => {
  const fn = /async function routeSignedIn\(\)\{([\s\S]*?)\n  \}/.exec(LOGIN)[1];
  const iStep = fn.indexOf('operatorTwoStep()'), iHq = fn.indexOf('operatorToHq()'), iOrg = fn.indexOf('resolveId()');
  assert.ok(iOrg >= 0 && iStep > iOrg && iHq > iStep, 'order: studio lookup → two-step → HQ');
  assert.match(fn, /if\(!\(await operatorTwoStep\(\)\)\) return;/);
});
t('login.html: operatorTwoStep has no skip — only "none"/"ok" continue; enroll/challenge loop; anything else fails closed', () => {
  const fn = /async function operatorTwoStep\(\)\{([\s\S]*?)\n  \}/.exec(LOGIN)[1];
  assert.match(fn, /if\(st==="none" \|\| st==="ok"\) return true;/);
  assert.match(fn, /if\(st==="enroll"\)\{ await operatorEnroll\(\); continue; \}/);
  assert.match(fn, /if\(st==="challenge"\)\{ await askMfaCode\(\); continue; \}/);
  assert.equal((fn.match(/return true/g) || []).length, 1);
  assert.match(fn, /return false;\s*$/);
});
t('login.html: set-up card has no close / later / skip control (only Sign out), and never names HQ', () => {
  const card = /<div class="card" id="mfaSetupForm" hidden>([\s\S]*?)\n    <\/div>/.exec(LOGIN)[1];
  assert.doesNotMatch(card, /later|skip|not now|close|cancel/i);
  assert.match(card, /id="mfaSetup_signout"/);
  assert.doesNotMatch(card, /\bHQ\b|platform|operator/i, 'no hint that an operator console exists');
  assert.match(card, /30 seconds/);
  assert.match(card, /security@helm\.events/);
});
t('login.html: code step shows the 30-second hint, the recovery contact and handles the lockout', () => {
  const form = /<form class="card" id="mfaForm"[\s\S]*?<\/form>/.exec(LOGIN)[0];
  assert.match(form, /refresh every 30 seconds/);
  assert.match(form, /security@helm\.events/);
  assert.match(LOGIN, /err\.code==="mfa_locked"/);
});
t('auth-ui.js: lockout message is shown as-is in the set-up flow', () => {
  const a = read('public/auth-ui.js');
  assert.match(a, /mfa_invalid\|mfa_locked/);
  assert.match(a, /Codes refresh every 30 seconds/);
});
t('studio admins: mfaRequiredForAdmins stays off in config.js (no forced MFA for studio users)', () => {
  assert.match(read('public/config.js'), /mfaRequiredForAdmins:\s*false/);
});

let pass = 0, fail = 0;
for (const [name, fn] of tests) {
  try { await fn(); pass++; console.log('ok - ' + name); }
  catch (e) { fail++; console.log('not ok - ' + name + ': ' + (e && e.message)); }
}
console.log(`\nhq-mfa: ${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
