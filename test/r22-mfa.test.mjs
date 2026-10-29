// r22-mfa.test.mjs — "make 2-step (MFA) working", end to end against a MOCKED supabase.auth.mfa API.
//  A. store-api.js (real file in a vm): enroll -> verify -> listFactors -> sign in again (aal1 -> "mfa" step, app
//     closed) -> challenge -> aal2 (app open) -> disable needs a CURRENT code -> unenroll; lockout; clear errors;
//     Google sign-in accounts enrol the same way; HQ operator: required-but-not-enrolled -> "enroll" (not locked out).
//  B. auth-ui.js (real file in a vm with a tiny DOM): Account -> Two-step section (turn on, turn off with a code,
//     "reset by Helm support" line); required-for-admins and not enrolled -> the set-up screen, never a dead end.
//  C. Static wiring: login.html code step / set-up screen, HQ reset button, 0253 SQL + APPLY + MANIFEST + DB suite,
//     config.toml local parity, owner test document.
// No network, no real credentials.
import { readFileSync, existsSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const root = new URL('..', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
const STORE = read('public/store-api.js');
const AUTHUI = read('public/auth-ui.js');
const tests = [];
const t = (name, fn) => tests.push([name, fn]);
const flush = async (n = 15) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

/* ------------------------------------------------------------------ mocked Supabase */
function memStore(init) {
  const m = new Map(Object.entries(init || {}));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}
function mockSupabase(o = {}) {
  const calls = [];
  const user = o.user || { id: 'u-1', email: 'planner@studio.test', app_metadata: { provider: 'email', providers: ['email'] } };
  const st = { aal: o.aal || 'aal1', factors: (o.factors || []).map((f) => Object.assign({ factor_type: 'totp' }, f)), srv: { fails: 0, until: 0 } };
  let session = { user, access_token: 'x' };
  const verified = () => st.factors.filter((f) => f.factor_type === 'totp' && f.status === 'verified');
  const client = {
    auth: {
      async getSession() { return { data: { session } }; },
      onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; },
      async refreshSession() { return { data: { session }, error: null }; },
      async signOut() { session = null; return { error: null }; },
      mfa: {
        async getAuthenticatorAssuranceLevel() { calls.push(['aal']); return { data: { currentLevel: st.aal, nextLevel: verified().length ? 'aal2' : st.aal }, error: null }; },
        async listFactors() { calls.push(['listFactors']); return { data: { all: st.factors, totp: verified() }, error: null }; },
        async enroll(a) {
          calls.push(['enroll', a.factorType]);
          if (o.enrollError) return { data: null, error: o.enrollError };
          const f = { id: 'f-' + (st.factors.length + 1), factor_type: 'totp', status: 'unverified' }; st.factors.push(f);
          return { data: { id: f.id, totp: { qr_code: '<svg xmlns="http://www.w3.org/2000/svg"></svg>', secret: 'JBSWY3DPEHPK3PXP' } }, error: null };
        },
        async unenroll({ factorId }) {
          calls.push(['unenroll', factorId]);
          const f = st.factors.find((x) => x.id === factorId);
          // Supabase rule: removing a VERIFIED factor needs an aal2 session
          if (f && f.status === 'verified' && st.aal !== 'aal2') return { error: { message: 'AAL2 required to unenroll verified factor', code: 'insufficient_aal' } };
          st.factors = st.factors.filter((x) => x.id !== factorId); return { error: null };
        },
        async challengeAndVerify({ factorId, code }) {
          calls.push(['verify', factorId, code]);
          if (o.rateLimited) return { error: { message: 'Too many requests', status: 429 } };
          if (code !== '123456') return { error: { message: 'Invalid TOTP code entered', status: 422, code: 'mfa_verification_failed' } };
          const f = st.factors.find((x) => x.id === factorId); if (!f) return { error: { message: 'Factor not found', status: 404 } };
          f.status = 'verified'; st.aal = 'aal2'; return { error: null };
        },
      },
    },
    async rpc(name) {
      calls.push(['rpc', name]);
      if (name === 'password_change_required') return { data: false, error: null };
      if (name === 'is_platform_operator') return { data: !!o.operator, error: null };
      if (name === 'is_platform_admin') return { data: !!o.operator && st.aal === 'aal2', error: null };
      if (name === 'operator_mfa_required') return { data: o.hqRequired !== false, error: null };
      if (name === 'my_mfa_reset_info') return o.resetInfo === 'missing' ? { data: null, error: { code: 'PGRST202', message: 'not found' } } : { data: o.resetInfo || null, error: null };
      if (name === 'mfa_lock_status' || name === 'mfa_record_failure') {
        const sv = st.srv, now = Date.now();
        if (sv.until && sv.until <= now) { sv.until = 0; sv.fails = 0; }
        if (name === 'mfa_record_failure' && !(sv.until > now)) { sv.fails++; if (sv.fails >= 5) sv.until = now + 900000; }
        return { data: { locked: sv.until > now, retry_after: sv.until > now ? Math.ceil((sv.until - now) / 1000) : 0, fails: sv.fails }, error: null };
      }
      if (name === 'mfa_record_success') { if (st.aal === 'aal2') { st.srv.fails = 0; st.srv.until = 0; } return { data: st.aal === 'aal2', error: null }; }
      return { data: null, error: null };
    },
    from() { const q = { select: () => q, eq: () => q, order: () => q, maybeSingle: async () => ({ data: null, error: null }), single: async () => ({ data: { role: 'admin' }, error: null }) }; return q; },
  };
  // "sign out and sign in again with the password": a fresh aal1 session for the same user
  const newSignIn = () => { st.aal = 'aal1'; session = { user, access_token: 'y' }; };
  return { client, calls, st, newSignIn, verified };
}
function storeEnv(o = {}) {
  const sb = mockSupabase(o);
  const loc = { pathname: o.path || '/login', search: '', hash: '', origin: 'https://www.helm.events', href: '', hostname: 'www.helm.events',
    replace(u) { sb.calls.push(['location.replace', u]); }, reload() {} };
  const stubEl = () => ({ style: {}, setAttribute() {}, appendChild() {}, addEventListener() {}, classList: { add() {}, remove() {}, contains: () => false } });
  const doc = { readyState: 'complete', title: '', addEventListener() {}, removeEventListener() {}, currentScript: { src: 'https://www.helm.events/store-api.js' },
    createElement: stubEl, head: { appendChild() {} }, body: stubEl(), querySelector: () => null, querySelectorAll: () => [], getElementById: () => null,
    documentElement: { setAttribute() {}, getAttribute() { return 'light'; }, classList: { contains: () => false, add() {}, remove() {} } } };
  const win = {
    SUPABASE_CONFIG: { url: 'https://abcdefghijklmnopqrst.supabase.co', anonKey: 'anon', auth: { mfaRequiredForAdmins: !!o.requiredForAdmins } },
    supabase: { createClient: () => sb.client }, localStorage: memStore(), sessionStorage: memStore(), location: loc, document: doc, navigator: { onLine: true },
    fetch: async () => ({ ok: false, status: 503, json: async () => ({}) }), addEventListener() {}, removeEventListener() {},
    setTimeout: (fn, ms) => { if (!ms || ms < 1000) { try { fn(); } catch (e) {} } return 0; }, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    atob: (b) => Buffer.from(b, 'base64').toString('binary'), console: { log() {}, info() {}, warn() {}, error() {} },
  };
  win.window = win; win.globalThis = win;
  vm.createContext(win);
  vm.runInContext(STORE, win, { filename: 'store-api.js' });
  return Object.assign({ win, S: win.BPStore }, sb);
}

/* ------------------------------------------------------------------ A. store-api flows */
t('A1 full cycle: enroll -> verify -> listFactors -> new sign-in is aal1 (app closed) -> challenge -> aal2 (app open)', async () => {
  const e = storeEnv();
  await e.S.init();
  assert.equal(e.S.auth.pendingStep(), null, 'no factor yet: nothing pending');
  const r = await e.S.auth.mfa.enrollTotp();
  assert.ok(r.factorId && /svg/.test(r.qr) && r.secret, 'QR + secret returned for the set-up screen');
  assert.equal((await e.S.auth.mfa.verifiedTotp()).length, 0, 'not on until the first code verifies');
  await e.S.auth.mfa.verify(r.factorId, ' 123 456 ');
  assert.equal((await e.S.auth.mfa.verifiedTotp()).length, 1, 'listFactors now shows one verified TOTP factor');
  assert.equal(e.st.aal, 'aal2');
  // sign out + sign in with the password again: Supabase gives aal1, the gate must ask for the code
  e.newSignIn();
  assert.equal(await e.S.auth.resolveGate(), 'mfa');
  assert.equal(e.S.auth.user(), null, 'while the code is owed, no page sees a signed-in user');
  assert.equal(e.S.auth.required(), true, 'every staff page sends the person to login.html');
  await assert.rejects(e.S.auth.mfa.challenge('000000'), (x) => x.code === 'mfa_invalid' && /30 seconds/.test(x.message));
  assert.equal(e.S.auth.pendingStep(), 'mfa', 'wrong code: still pending');
  await e.S.auth.mfa.challenge('123456');
  assert.equal(e.S.auth.pendingStep(), null, 'right code: aal2, app open');
  assert.ok(e.S.auth.user());
});
t('A2 "remember": an aal2 session stays aal2 (no code on every page); a NEW sign-in always asks again', async () => {
  const e = storeEnv({ factors: [{ id: 'f-1', status: 'verified' }], aal: 'aal2' });
  await e.S.init();
  assert.equal(e.S.auth.pendingStep(), null);
  assert.equal(await e.S.auth.resolveGate(), null, 're-checking the gate on the same session does not ask again');
  e.newSignIn();
  assert.equal(await e.S.auth.resolveGate(), 'mfa');
});
t('A3 turning two-step OFF needs a current code: none / wrong -> refused and still on; right -> unenrolled', async () => {
  const e = storeEnv({ factors: [{ id: 'f-1', status: 'verified' }], aal: 'aal2' });
  await e.S.init();
  await assert.rejects(e.S.auth.mfa.disable(''), /Enter the 6-digit code/);
  await assert.rejects(e.S.auth.mfa.disable('999999'), (x) => x.code === 'mfa_invalid');
  assert.equal(e.verified().length, 1, 'still on after a wrong code');
  assert.ok(!e.calls.some((c) => c[0] === 'unenroll'), 'nothing unenrolled without the code');
  await e.S.auth.mfa.disable('123456');
  assert.equal(e.st.factors.length, 0, 'factor removed');
  assert.deepEqual(e.calls.filter((c) => c[0] === 'unenroll').map((c) => c[1]), ['f-1']);
  e.newSignIn();
  assert.equal(await e.S.auth.resolveGate(), null, 'next sign-in: password only');
});
t('A4 rate limiting: 5 wrong codes lock code entry (even the right code) and say how long', async () => {
  const e = storeEnv({ factors: [{ id: 'f-1', status: 'verified' }], aal: 'aal1' });
  await e.S.init();
  for (let i = 0; i < 4; i++) await assert.rejects(e.S.auth.mfa.challenge('111111'), (x) => x.code === 'mfa_invalid');
  await assert.rejects(e.S.auth.mfa.challenge('111111'), (x) => x.code === 'mfa_locked' && x.retryAfter > 0 && /wait 15 minutes/.test(x.message));
  const before = e.calls.filter((c) => c[0] === 'verify').length;
  await assert.rejects(e.S.auth.mfa.challenge('123456'), (x) => x.code === 'mfa_locked');
  assert.equal(e.calls.filter((c) => c[0] === 'verify').length, before, 'locked: the code is not even sent to Supabase');
  assert.equal(e.S.auth.pendingStep(), 'mfa');
  // Supabase's own 429 also becomes a clear pause, not a "wrong code"
  const e2 = storeEnv({ factors: [{ id: 'f-1', status: 'verified' }], aal: 'aal1', rateLimited: true });
  await e2.S.init();
  await assert.rejects(e2.S.auth.mfa.challenge('123456'), (x) => x.code === 'mfa_locked');
});
t('A5 clear errors: TOTP switched off in the Supabase dashboard / too many factors / aal2 needed', async () => {
  const e = storeEnv({ enrollError: { message: 'MFA enroll is disabled for TOTP', code: 'mfa_totp_enroll_not_enabled', status: 422 } });
  await e.S.init();
  await assert.rejects(e.S.auth.mfa.enrollTotp(), (x) => x.code === 'mfa_unavailable' && /switched off/.test(x.message) && /security@helm\.events/.test(x.message));
  const e2 = storeEnv({ enrollError: { message: 'Maximum number of verified factors reached', code: 'too_many_enrolled_mfa_factors', status: 422 } });
  await e2.S.init();
  await assert.rejects(e2.S.auth.mfa.enrollTotp(), (x) => x.code === 'mfa_unavailable');
  const e3 = storeEnv({ factors: [{ id: 'f-1', status: 'verified' }], aal: 'aal1' });
  await e3.S.init();
  await assert.rejects(e3.S.auth.mfa.unenroll('f-1'), (x) => x.code === 'mfa_aal2_required' && /sign in again/.test(x.message));
});
t('A6 unfinished enrolment is replaced (no duplicate-factor error on a second try)', async () => {
  const e = storeEnv();
  await e.S.init();
  await e.S.auth.mfa.enrollTotp();
  const r2 = await e.S.auth.mfa.enrollTotp();
  assert.equal(e.st.factors.length, 1);
  assert.equal(e.st.factors[0].id, r2.factorId);
});
t('A7 Google sign-in accounts enrol and are challenged exactly the same way', async () => {
  const e = storeEnv({ user: { id: 'g-1', email: 'g@studio.test', app_metadata: { provider: 'google', providers: ['google'] }, identities: [{ provider: 'google' }] } });
  await e.S.init();
  assert.equal(e.S.auth.hasPassword(), false);
  const r = await e.S.auth.mfa.enrollTotp();
  await e.S.auth.mfa.verify(r.factorId, '123456');
  e.newSignIn();
  assert.equal(await e.S.auth.resolveGate(), 'mfa');
  await e.S.auth.mfa.challenge('123456');
  assert.equal(e.S.auth.pendingStep(), null);
});
t('A8 HQ operator, hq_require_mfa ON, no authenticator -> "enroll" (guided set-up, not locked out); then "ok"', async () => {
  const e = storeEnv({ operator: true, hqRequired: true, user: { id: 'op-1', email: 'admin@helm.events' } });
  await e.S.init();
  assert.equal(await e.S.auth.mfa.operatorStep(), 'enroll');
  const r = await e.S.auth.mfa.enrollTotp();
  await e.S.auth.mfa.verify(r.factorId, '123456');
  assert.equal(await e.S.auth.mfa.operatorStep(), 'ok');
  e.newSignIn(); await e.S.auth.resolveGate();
  assert.equal(await e.S.auth.mfa.operatorStep(), 'challenge', 'next sign-in: the code, every time');
  const off = storeEnv({ operator: true, hqRequired: false, user: { id: 'op-2', email: 'ops@helm.events' } });
  await off.S.init();
  assert.equal(await off.S.auth.mfa.operatorStep(), 'ok', 'switch off + no authenticator: HQ at aal1 (0047)');
});
t('A9 resetInfo(): reset time from my_mfa_reset_info (0253); missing function -> null', async () => {
  const e = storeEnv({ resetInfo: { reset_at: '2026-10-19T05:00:00Z' } });
  await e.S.init();
  assert.deepEqual(JSON.parse(JSON.stringify(await e.S.auth.mfa.resetInfo())), { reset_at: '2026-10-19T05:00:00Z' });
  const e2 = storeEnv({ resetInfo: 'missing' });
  await e2.S.init();
  assert.equal(await e2.S.auth.mfa.resetInfo(), null);
});

/* ------------------------------------------------------------------ B. auth-ui with a tiny DOM */
function tinyDom() {
  const byId = new Map();
  function node(tag) {
    const n = {
      tagName: String(tag).toUpperCase(), children: [], parentNode: null, attrs: {}, style: {}, listeners: {}, _text: '', className: '', value: '', disabled: false,
      get isConnected() { let p = this; while (p.parentNode) p = p.parentNode; return p === body; },
      get hidden() { return 'hidden' in this.attrs; }, set hidden(v) { if (v) this.attrs.hidden = ''; else delete this.attrs.hidden; },
      get id() { return this.attrs.id || ''; },
      setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id') byId.set(String(v), this); },
      getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
      appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.children.push(c); return c; },
      insertBefore(c, ref) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; const i = this.children.indexOf(ref); if (i < 0) this.children.push(c); else this.children.splice(i, 0, c); return c; },
      removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; return c; },
      remove() { if (this.parentNode) this.parentNode.removeChild(this); },
      get firstChild() { return this.children[0] || null; },
      get textContent() { return this._text + this.children.map((c) => c.textContent).join(' '); },
      set textContent(v) { this._text = String(v); this.children.forEach((c) => { c.parentNode = null; }); this.children = []; },
      addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
      removeEventListener() {},
      click() { (this.listeners.click || []).forEach((f) => f({ preventDefault() {} })); },
      focus() {}, select() {}, scrollIntoView() {},
      querySelector() { return null; }, querySelectorAll() { return []; },
      classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
    };
    return n;
  }
  const body = node('body'), head = node('head');
  const all = (n, out = []) => { out.push(n); n.children.forEach((c) => all(c, out)); return out; };
  const doc = {
    readyState: 'complete', body, head, createElement: node, createElementNS: (ns, t2) => node(t2), createTextNode: (s) => Object.assign(node('#text'), { _text: String(s) }),
    getElementById: (id) => { const n = byId.get(id); return n && n.isConnected ? n : null; },
    querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, removeEventListener() {},
    documentElement: { classList: { contains: () => false, add() {}, remove() {} }, setAttribute() {}, getAttribute() { return null; } },
  };
  return { doc, body, all, buttons: (root2, label) => all(root2).filter((n) => n.tagName === 'BUTTON' && n._text === label) };
}
function uiEnv(mfa, o = {}) {
  const dom = tinyDom();
  const win = { document: dom.doc, console, setTimeout: (fn) => { try { fn(); } catch (e) {} return 0; }, clearTimeout() {}, sessionStorage: memStore(), localStorage: memStore(),
    addEventListener() {}, removeEventListener() {}, location: { pathname: '/dashboard', replace() {} }, navigator: {},
    BPStore: { auth: { user: () => ({ id: 'u-1', email: 'a@studio.test' }), role: () => o.role || 'admin', hasPassword: () => o.hasPassword !== false, mfa, signOut: async () => {} } } };
  win.window = win; win.global = win;
  vm.createContext(win);
  vm.runInContext(AUTHUI, win, { filename: 'auth-ui.js' });
  return Object.assign({ win, UI: win.HelmAuthUI }, dom);
}
function fakeMfa(o = {}) {
  const calls = [];
  let on = !!o.on;
  return {
    calls,
    verifiedTotp: async () => (on ? [{ id: 'f-1', status: 'verified' }] : []),
    enrollTotp: async () => { calls.push('enroll'); if (o.enrollError) throw o.enrollError; return { factorId: 'f-1', qr: '<svg xmlns="http://www.w3.org/2000/svg"></svg>', secret: 'JBSWY3DPEHPK3PXP' }; },
    verify: async (id, code) => { calls.push(['verify', code]); if (code !== '123456') { const e = new Error('That code didn\'t work.'); e.code = 'mfa_invalid'; throw e; } on = true; return true; },
    disable: async (code) => { calls.push(['disable', code]); if (code !== '123456') { const e = new Error('That code didn\'t work.'); e.code = 'mfa_invalid'; throw e; } on = false; return true; },
    resetInfo: async () => o.resetInfo || null,
    requiredForAdmins: () => !!o.required,
    isOn: () => on,
  };
}
const inputs = (dom, root2) => dom.all(root2).filter((n) => n.tagName === 'INPUT');
const text = (n) => n.textContent.replace(/\s+/g, ' ');

t('B1 Account -> Two-step (off): Turn on -> QR + key -> wrong code shows the error -> right code -> "on"', async () => {
  const m = fakeMfa();
  const u = uiEnv(m);
  const box = u.doc.createElement('div'); u.body.appendChild(box);
  u.UI._mfaSection(box); await flush();
  assert.match(text(box), /Off\. Turn it on so a stolen password alone/);
  u.buttons(box, 'Turn on')[0].click(); await flush();
  assert.ok(u.all(box).some((n) => n.tagName === 'IMG' && /^data:image\/svg\+xml/.test(n.attrs.src)), 'QR image shown');
  assert.match(text(box), /JBSWY3DPEHPK3PXP/, 'the key for manual entry is shown');
  const code = inputs(u, box)[0];
  code.value = '000000'; u.buttons(box, 'Verify & turn on')[0].click(); await flush();
  assert.match(text(box), /That code didn't work/);
  code.value = '123456'; u.buttons(box, 'Verify & turn on')[0].click(); await flush();
  assert.equal(m.isOn(), true);
  assert.match(text(box), /Two-step verification is on|On — you enter a code/, 'the section now shows "on"');
});
t('B2 Account -> Two-step (on): Turn off asks for a code; wrong code keeps it on; right code turns it off', async () => {
  const m = fakeMfa({ on: true });
  const u = uiEnv(m);
  const box = u.doc.createElement('div'); u.body.appendChild(box);
  u.UI._mfaSection(box); await flush();
  assert.match(text(box), /On — you enter a code/);
  assert.match(text(box), /Lost your phone\?[\s\S]*security@helm\.events/);
  u.buttons(box, 'Turn off')[0].click(); await flush();
  assert.match(text(box), /Enter the 6-digit code from your authenticator app to turn two-step off/);
  const code = inputs(u, box)[0];
  code.value = '111111'; u.buttons(box, 'Turn off two-step')[0].click(); await flush();
  assert.equal(m.isOn(), true, 'still on');
  assert.match(text(box), /That code didn't work/);
  code.value = '123456'; u.buttons(box, 'Turn off two-step')[0].click(); await flush();
  assert.equal(m.isOn(), false);
  assert.match(text(box), /Off\./);
});
t('B3 after a Helm support reset (0253) the Off state says when, and Google accounts get Google wording', async () => {
  const u = uiEnv(fakeMfa({ resetInfo: { reset_at: '2026-10-19T05:00:00Z' } }), { hasPassword: false });
  const box = u.doc.createElement('div'); u.body.appendChild(box);
  u.UI._mfaSection(box); await flush();
  assert.match(text(box), /Helm support reset your two-step verification on .+\. Set it up again on your new phone\./);
  assert.match(text(box), /Google account/);
});
t('B4 required for admins + not enrolled -> blocking set-up screen with Sign out; finishing removes it', async () => {
  const m = fakeMfa({ required: true });
  const u = uiEnv(m);
  u.UI._adminTwoStep(); await flush();
  const ov = u.doc.getElementById('hauForce');
  assert.ok(ov, 'set-up screen shown');
  assert.match(text(ov), /requires admins to use two-step/);
  assert.equal(u.buttons(ov, 'Sign out').length, 1, 'a way out: sign out');
  assert.equal(u.buttons(ov, 'Continue for now').length, 0, 'no skip while set-up works');
  inputs(u, ov)[0].value = '123456'; u.buttons(ov, 'Verify & turn on')[0].click(); await flush();
  assert.equal(m.isOn(), true);
  assert.equal(u.doc.getElementById('hauForce'), null, 'screen closes once two-step is on');
});
t('B5 required for admins but Supabase TOTP is switched off -> clear message + "Continue for now" (never a dead end)', async () => {
  const err = Object.assign(new Error('Two-step set-up is switched off for this Helm site right now.'), { code: 'mfa_unavailable' });
  const u = uiEnv(fakeMfa({ required: true, enrollError: err }));
  u.UI._adminTwoStep(); await flush();
  const ov = u.doc.getElementById('hauForce');
  assert.match(text(ov), /switched off for this Helm site/);
  assert.equal(u.buttons(ov, 'Try again').length, 1);
  u.buttons(ov, 'Continue for now')[0].click();
  assert.equal(u.doc.getElementById('hauForce'), null);
});
t('B6 not required: an admin without two-step is never blocked (nudge only); non-admins see nothing', async () => {
  const u = uiEnv(fakeMfa({ required: false }));
  u.UI._adminTwoStep(); await flush();
  assert.equal(u.doc.getElementById('hauForce'), null);
  const u2 = uiEnv(fakeMfa({ required: true }), { role: 'planner' });
  u2.UI._adminTwoStep(); await flush();
  assert.equal(u2.doc.getElementById('hauForce'), null);
});

/* ------------------------------------------------------------------ C. static wiring */
t('C1 login.html: aal1 -> code step (finishGate "mfa" -> askMfaCode -> mfa.challenge), lockout countdown, recovery contact', () => {
  const L = read('public/login.html');
  assert.match(L, /if\(step==="mfa"\)\{ await askMfaCode\(\); continue; \}/);
  assert.match(L, /await BPStore\.auth\.mfa\.challenge\(\$\("#mfa_code"\)\.value\)/);
  assert.match(L, /autocomplete="one-time-code"/);
  assert.match(L, /security@helm\.events[\s\S]{0,200}set it up again on your new phone/);
  assert.match(L, /if\(st==="enroll"\)\{ await operatorEnroll\(\); continue; \}/);
});
t('C2 hq.js: Reset button only for 2-step "on" rows, never your own; reason + e-mail retype; calls hq_mfa_reset', () => {
  const H = read('public/hq.js');
  // r57 (0298): the list address is masked - same checks against the masked / revealed address (sameAddr, hq_reveal)
  assert.match(H, /function mfaCell\(email, on, after(, rec)?\)/);
  assert.match(H, /if \(on && email && (can\("security\.write"\) && )?(String\(email\)\.toLowerCase\(\) !== String\(me\)\.toLowerCase\(\)|!sameAddr\(email, me\))\)/);
  assert.match(H, /call\("hq_mfa_reset", \{ p_email: (email|isMasked\(email\) \? again : email), p_reason: why \}\)/);
  assert.match(H, /Type the person's e-mail address to confirm/);
  assert.match(H, /mfaCell\(r\.email, r\.mfa_enabled/);
  assert.match(H, /mfaCell\(m\.email, m\.mfa_enabled/);
});
t('C3 0253 SQL: aal2 always, no self-bypass, reason, rate limit, audit, append-only, never deletes a factor', () => {
  const M = read('supabase/migrations/0253_mfa_assisted_reset.sql');
  const code = M.replace(/--.*$/gm, '');
  assert.match(code, /not public\.is_platform_admin\(\) or v_aal <> 'aal2'/);
  assert.match(code, /if v_target = v_me then/);
  assert.match(code, /length\(v_reason\) < 10/);
  assert.match(code, /v_recent >= 10/);
  assert.match(code, /public\._hq_wgate\('hq\.mfa\.reset'/);
  assert.match(code, /set status = ''unverified''/);
  assert.doesNotMatch(code, /delete from|drop table|truncate public|drop function/i, 'nothing destructive');
  assert.match(code, /before update or delete on public\.mfa_resets/);
  assert.match(code, /if public\._hq_require_mfa\(\) then return false; end if;/, 'switch on => aal2 for every HQ call');
  assert.ok(!/[^\x00-\x7f]/.test(M), 'ASCII only');
});
t('C4 APPLY-0253 = begin + migration verbatim + commit + VERIFY; MANIFEST + DB suite registered', () => {
  const M = read('supabase/migrations/0253_mfa_assisted_reset.sql'), A = read('supabase/APPLY-0253.sql');
  assert.ok(A.includes('begin;\n' + M + 'commit;'), 'APPLY carries the migration verbatim');
  assert.match(A, /-- VERIFY \(every row must say ok = true\)/);
  assert.ok(!/[^\x00-\x7f]/.test(A), 'ASCII only');
  assert.match(read('supabase/migrations/MANIFEST'), /\nforward  supabase\/migrations\/0253_mfa_assisted_reset\.sql\n/);
  assert.match(read('scripts/db-test/run-all.sh'), /R22-MFA-RESET-0253: ALL PASS \\\(30\/30\\\)" psql -q -f tests\/db\/r22-mfa-reset-0253\.sql/);
});
t('C5 config.toml: TOTP enrol + verify on (local parity); owner test document exists and covers the steps', () => {
  const C = read('supabase/config.toml');
  assert.match(C, /\[auth\.mfa\.totp\]\nenroll_enabled = true\nverify_enabled = true/);
  assert.ok(existsSync(new URL('docs/security/MFA-OWNER-TEST-R22.md', root)));
  const D = read('docs/security/MFA-OWNER-TEST-R22.md');
  for (const re of [/Google Authenticator/, /Multi-Factor/, /hq_require_mfa/, /R21-SECURITY-PREFLIGHT\.sql/, /lost/i, /APPLY-0253\.sql/, /Reset/]) assert.match(D, re);
});

let pass = 0, fail = 0;
for (const [name, fn] of tests) {
  try { await fn(); pass++; console.log('ok - ' + name); }
  catch (e) { fail++; console.log('not ok - ' + name + ': ' + (e && e.stack || e)); }
}
console.log(`\nr22-mfa: ${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
