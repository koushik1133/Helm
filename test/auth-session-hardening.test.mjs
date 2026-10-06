// Auth + session hardening (audit Phase 3-4 follow-up). Runs public/store-api.js in a
// sandbox with a stub Supabase client and checks the behaviour that protects sign-in:
//   CAPTCHA on/off, the password rule, generic password-reset answers, the two-step
//   (aal2) gate, the temp-password gate failing CLOSED, idle / max-age logout across
//   tabs, no session limits on public client pages, Google without offline access,
//   plus the static page / header wiring (reset page, no-store, Turnstile CSP scope).
import { readFileSync, existsSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const root = new URL('..', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
const SRC = read('public/store-api.js');
let n = 0;
const tests = [];
const t = (name, fn) => tests.push([name, fn]);

/* ----------------------------------------------------------- sandbox */
function memStore(init) {
  const m = new Map(Object.entries(init || {}));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _m: m };
}
function makeEnv(o = {}) {
  const calls = [];
  let now = o.now || Date.UTC(2026, 9, 6, 9, 0, 0);
  const clock = { get: () => now, advance: (ms) => { now += ms; } };
  const RealDate = Date;
  class FakeDate extends RealDate { constructor(...a) { if (a.length) super(...a); else super(now); } static now() { return now; } }
  const intervals = [];
  const user = o.user === null ? null : (o.user || { id: 'u-1', email: 'staff@a.test', factors: [] });
  let session = user ? { user, access_token: 'x' } : null;
  const listeners = [];
  const supaAuth = {
    async getSession() { return { data: { session } }; },
    onAuthStateChange(cb) { listeners.push(cb); return { data: { subscription: { unsubscribe() {} } } }; },
    async signInWithPassword(arg) { calls.push(['signInWithPassword', arg]); if (o.signInError) return { data: {}, error: o.signInError }; session = { user: o.signInUser || user || { id: 'u-1', email: arg.email } }; return { data: { user: session.user, session }, error: null }; },
    async signUp(arg) { calls.push(['signUp', arg]); return { data: { user: { id: 'u-new' }, session: null }, error: null }; },
    async signInWithOAuth(arg) { calls.push(['signInWithOAuth', arg]); return { data: {}, error: null }; },
    async signOut(arg) { calls.push(['signOut', arg || null]); if (!arg || arg.scope !== 'others') session = null; return { error: null }; },
    async resetPasswordForEmail(email, opts) { calls.push(['resetPasswordForEmail', email, opts]); return { data: {}, error: o.resetError || null }; },
    async updateUser(arg) { calls.push(['updateUser', arg]); return { data: {}, error: o.updateError || null }; },
    async refreshSession() { return { data: { session }, error: session ? null : { message: 'no' } }; },
    mfa: {
      async getAuthenticatorAssuranceLevel() { calls.push(['aal']); if (o.aalError) return { data: null, error: o.aalError }; return { data: o.aal || { currentLevel: 'aal1', nextLevel: 'aal1' }, error: null }; },
      async listFactors() { return { data: { all: o.factors || [] }, error: null }; },
      async challengeAndVerify(arg) { calls.push(['challengeAndVerify', arg]); if (arg.code !== '123456') return { data: null, error: { message: 'Invalid TOTP code entered' } }; o.aal = { currentLevel: 'aal2', nextLevel: 'aal2' }; return { data: {}, error: null }; },
      async enroll(arg) { calls.push(['enroll', arg]); return { data: { id: 'f-1', totp: { qr_code: 'data:image/svg+xml;utf-8,<svg xmlns="http://www.w3.org/2000/svg"></svg>', secret: 'ABC' } }, error: null }; },
      async unenroll(arg) { calls.push(['unenroll', arg]); return { data: {}, error: null }; },
    },
  };
  const client = {
    auth: supaAuth,
    async rpc(name, args) {
      calls.push(['rpc', name, args]);
      const r = (o.rpc || {})[name];
      if (typeof r === 'function') return r(args);
      if (r) return r;
      return { data: null, error: null };
    },
    from() { const q = { select: () => q, eq: () => q, order: () => q, single: async () => ({ data: { role: o.role || 'sales' }, error: null }) }; return q; },
  };
  const loc = { pathname: o.path || '/dashboard', search: o.search || '', hash: o.hash || '', origin: 'https://www.helm.events', href: '', hostname: 'www.helm.events',
    replace(u) { calls.push(['location.replace', u]); }, reload() { calls.push(['location.reload']); } };
  const doc = {
    readyState: 'loading', addEventListener() {}, removeEventListener() {}, currentScript: { src: 'https://www.helm.events/store-api.js?v=1' },
    createElement: (tag) => ({ tag, style: {}, setAttribute() {}, appendChild() {}, addEventListener() {}, querySelector: () => null, remove() {}, set src(v) { calls.push(['script', v]); }, get src() { return ''; } }),
    head: { appendChild() {} }, body: { appendChild() {}, insertBefore() {} }, documentElement: { setAttribute() {}, getAttribute() { return 'light'; } },
    querySelector: () => null, querySelectorAll: () => [], getElementById: () => null, hidden: false,
  };
  const win = {
    SUPABASE_CONFIG: Object.assign({ url: 'https://abcdefghijklmnopqrst.supabase.co', anonKey: 'anon' }, o.cfg || {}),
    supabase: { createClient: () => client },
    localStorage: memStore(o.ls), sessionStorage: memStore(o.ss),
    location: loc, document: doc, navigator: { onLine: true },
    fetch: async () => ({ status: 200, ok: true, json: async () => ({}) }),
    addEventListener() {}, removeEventListener() {},
    setTimeout: (fn) => { try { fn(); } catch (e) {} return 0; }, clearTimeout() {},
    setInterval: (fn, ms) => { intervals.push(fn); return intervals.length; }, clearInterval: (id) => { intervals[id - 1] = null; },
    console, Date: FakeDate, Promise, URLSearchParams, URL, JSON, Math, Object, Array, String, Number, RegExp, Error, Map, Set,
  };
  win.window = win; win.globalThis = win;
  vm.createContext(win);
  vm.runInContext(SRC, win, { filename: 'store-api.js' });
  return { win, S: win.BPStore, calls, clock, intervals, tick: () => intervals.forEach((f) => f && f()), emit: (ev, s) => listeners.forEach((cb) => cb(ev, s)) };
}
const flush = () => new Promise((r) => setImmediate(r));
const CAPTCHA_ON = { captcha: { provider: 'turnstile', siteKey: '0x4AAAAAAA-test-site-key' } };

/* ------------------------------------------------------- 1. CAPTCHA */
t('CAPTCHA OFF (empty siteKey, the default): sign-in sends exactly email+password, as before', async () => {
  const e = makeEnv({ user: null, path: '/login' });
  await e.S.init();
  assert.equal(e.S.auth.captcha.enabled(), false);
  await e.S.auth.signIn('a@b.co', 'pw');
  const c = e.calls.find((x) => x[0] === 'signInWithPassword');
  assert.deepEqual(JSON.parse(JSON.stringify(c[1])), { email: 'a@b.co', password: 'pw' });
});
t('committed config.js ships CAPTCHA off (empty siteKey) and the documented defaults', () => {
  const cfg = read('public/config.js');
  assert.match(cfg, /captcha:\s*\{\s*provider:\s*"turnstile",\s*siteKey:\s*""\s*\}/);
  assert.match(cfg, /mfaRequiredForAdmins:\s*false/);
  assert.match(cfg, /session:\s*\{\s*idleMinutes:\s*30,\s*warnSeconds:\s*60,\s*maxHours:\s*12\s*\}/);
});
t('CAPTCHA ON: sign-in / sign-up / reset carry captchaToken; missing token is refused before any request', async () => {
  const e = makeEnv({ user: null, path: '/login', cfg: CAPTCHA_ON });
  await e.S.init();
  assert.equal(e.S.auth.captcha.enabled(), true);
  assert.equal(e.S.auth.captcha.siteKey(), '0x4AAAAAAA-test-site-key');
  await assert.rejects(e.S.auth.signIn('a@b.co', 'pw'), (x) => x.code === 'captcha_required');
  assert.ok(!e.calls.some((x) => x[0] === 'signInWithPassword'), 'no request without a token');
  await e.S.auth.signIn('a@b.co', 'pw', { captchaToken: 'tok1' });
  assert.equal(e.calls.find((x) => x[0] === 'signInWithPassword')[1].options.captchaToken, 'tok1');
  await e.S.auth.signUp('n@b.co', 'longpassword12', { captchaToken: 'tok2' });
  assert.equal(e.calls.find((x) => x[0] === 'signUp')[1].options.captchaToken, 'tok2');
  await e.S.auth.requestPasswordReset('n@b.co', { captchaToken: 'tok3' });
  assert.equal(e.calls.find((x) => x[0] === 'resetPasswordForEmail')[2].captchaToken, 'tok3');
  await assert.rejects(e.S.auth.requestPasswordReset('n@b.co'), (x) => x.code === 'captcha_required');
});
t('CAPTCHA ON: an in-page sign-in box (no widget) is sent to the sign-in page', async () => {
  const e = makeEnv({ user: null, path: '/dashboard', cfg: CAPTCHA_ON });
  await e.S.init();
  await assert.rejects(e.S.auth.signIn('a@b.co', 'pw'));
  assert.match(e.win.location.href, /^login\.html\?next=dashboard/);
});

/* ------------------------------------------------- 2. password rule */
t('password rule: >= 12 chars with a letter and a number (signup / change / admin create)', async () => {
  const e = makeEnv({ user: null, path: '/login' });
  const p = e.S.auth.passwordRule.problem;
  assert.ok(p('short1'));
  assert.ok(p('abcdefghijklmnop'));
  assert.ok(p('123456789012345'));
  assert.equal(p('abcdefghij12'), null);
  assert.equal(e.S.auth.passwordRule.min, 12);
  await e.S.init();
  await assert.rejects(e.S.auth.signUp('a@b.co', 'onlyletterslong'));
  assert.ok(!e.calls.some((x) => x[0] === 'signUp'), 'weak password never reaches Supabase');
  await assert.rejects(e.S.auth.admin.createUser('x@b.co', 'pw12', 'sales'));
  assert.ok(!e.calls.some((x) => x[0] === 'rpc' && x[1] === 'admin_create_user'));
});

/* ----------------------------------------------- 3. password reset */
t('reset request: same result whether or not the account exists; redirect to /reset-password', async () => {
  const a = makeEnv({ user: null, path: '/login' }); await a.S.init();
  assert.equal(await a.S.auth.requestPasswordReset('known@b.co'), true);
  assert.equal(a.calls.find((x) => x[0] === 'resetPasswordForEmail')[2].redirectTo, 'https://www.helm.events/reset-password');
  const b = makeEnv({ user: null, path: '/login', resetError: { status: 400, message: 'User not found' } }); await b.S.init();
  assert.equal(await b.S.auth.requestPasswordReset('unknown@b.co'), true, 'a "not found" answer is swallowed');
  const c = makeEnv({ user: null, path: '/login', resetError: { status: 429, message: 'Email rate limit exceeded' } }); await c.S.init();
  await assert.rejects(c.S.auth.requestPasswordReset('x@b.co'), (x) => x.code === 'rate_limited');
});
t('a recovery link that lands on another page is handed to /reset-password (never a silent sign-in)', async () => {
  const e = makeEnv({ path: '/', hash: '#access_token=a&refresh_token=b&type=recovery' });
  e.S.init();
  await flush();
  assert.deepEqual(e.calls.find((x) => x[0] === 'location.replace'), ['location.replace', '/reset-password#access_token=a&refresh_token=b&type=recovery']);
});
t('an unfinished reset keeps the app closed (pending "recovery") until the new password is set', async () => {
  const e = makeEnv({ path: '/dashboard', ls: { bp_recovery_pending: 'u-1' } });
  await e.S.init();
  assert.equal(e.S.auth.pendingStep(), 'recovery');
  assert.equal(e.S.auth.user(), null);
  assert.equal(e.S.auth.required(), true);
  await e.S.auth.updatePassword('newpassword123');
  assert.equal(e.win.localStorage.getItem('bp_recovery_pending'), null);
  assert.ok(e.calls.some((x) => x[0] === 'signOut' && x[1] && x[1].scope === 'others'), 'other sessions signed out');
});

/* ------------------------------------------------ 4. two-step gate */
t('MFA: verified factor + aal1 session → app pages are gated (user() null, required() true)', async () => {
  const e = makeEnv({ aal: { currentLevel: 'aal1', nextLevel: 'aal2' } });
  await e.S.init();
  assert.equal(e.S.auth.pendingStep(), 'mfa');
  assert.equal(e.S.auth.user(), null);
  assert.equal(e.S.auth.pendingUser().id, 'u-1');
  assert.equal(e.S.auth.required(), true, 'page gate redirects to login');
  assert.equal(await e.S.auth.requireView('quotes'), false, 'requireView refuses too');
});
t('MFA: a wrong code keeps the gate shut; the right code opens it (aal2)', async () => {
  const o = { aal: { currentLevel: 'aal1', nextLevel: 'aal2' }, factors: [{ id: 'f-1', factor_type: 'totp', status: 'verified' }] };
  const e = makeEnv(o);
  await e.S.init();
  await assert.rejects(e.S.auth.mfa.challenge('000000'), (x) => x.code === 'mfa_invalid');
  assert.equal(e.S.auth.pendingStep(), 'mfa');
  await assert.rejects(e.S.auth.mfa.challenge('12ab'), /6-digit/);
  await e.S.auth.mfa.challenge('123456');
  assert.equal(e.S.auth.pendingStep(), null);
  assert.equal(e.S.auth.user().id, 'u-1');
});
t('MFA: no factor (aal1/aal1) → nothing changes for existing users', async () => {
  const e = makeEnv({ aal: { currentLevel: 'aal1', nextLevel: 'aal1' } });
  await e.S.init();
  assert.equal(e.S.auth.pendingStep(), null);
  assert.equal(e.S.auth.user().id, 'u-1');
  assert.equal(e.S.auth.required(), false);
});
t('MFA enrolment removes unfinished factors first and returns the SVG QR + secret', async () => {
  const e = makeEnv({ factors: [{ id: 'old', factor_type: 'totp', status: 'unverified' }, { id: 'ok', factor_type: 'totp', status: 'verified' }] });
  await e.S.init();
  const r = await e.S.auth.mfa.enrollTotp();
  assert.deepEqual(e.calls.filter((x) => x[0] === 'unenroll').map((x) => x[1].factorId), ['old']);
  assert.match(r.qr, /^data:image\/svg\+xml/);
  assert.equal(r.factorId, 'f-1');
});

/* ------------------------------------ 5. temp password fails CLOSED */
t('temp password: must_change → gated as "password"', async () => {
  const e = makeEnv({ rpc: { password_change_required: { data: true, error: null } } });
  await e.S.init();
  assert.equal(e.S.auth.pendingStep(), 'password');
  assert.equal(e.S.auth.user(), null);
});
t('temp password: the status check failing (network) keeps the app CLOSED ("verify")', async () => {
  const e = makeEnv({ rpc: { password_change_required: { data: null, error: { message: 'Failed to fetch' } } } });
  await e.S.init();
  assert.equal(e.S.auth.pendingStep(), 'verify');
  assert.equal(e.S.auth.user(), null);
  await assert.rejects(e.S.auth.passwordChangeRequired(), 'passwordChangeRequired throws instead of answering "no"');
});
t('temp password: database without the function → not gated (no lock-out)', async () => {
  const e = makeEnv({ rpc: { password_change_required: { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } } } });
  await e.S.init();
  assert.equal(e.S.auth.pendingStep(), null);
});
t('temp password: a failed flag clear is an error, not ignored; retry does not re-send the password', async () => {
  let fail = true;
  const e = makeEnv({ rpc: { password_change_required: { data: true, error: null }, clear_password_change_required: () => (fail ? { data: null, error: { message: 'set a new password first' } } : { data: null, error: null }) } });
  await e.S.init();
  await assert.rejects(e.S.auth.completePasswordChange('brandnewpass12'));
  assert.equal(e.calls.filter((x) => x[0] === 'updateUser').length, 1);
  fail = false;
  e.win.SUPABASE_CONFIG.__x = 1;
  await e.S.auth.completePasswordChange('brandnewpass12');
  assert.equal(e.calls.filter((x) => x[0] === 'updateUser').length, 1, 'password not re-sent on retry');
  await assert.rejects(e.S.auth.completePasswordChange('short'), /12 characters/);
});

/* ---------------------------------------------- 6. session limits */
t('session decision: defaults 30 min idle (60 s warning) and 12 h max; 0 turns a limit off', () => {
  const e = makeEnv();
  const cfg = e.S.auth.sessionLimits.config();
  assert.equal(cfg.idleMs, 30 * 60000); assert.equal(cfg.warnMs, 60000); assert.equal(cfg.maxMs, 12 * 3600000);
  const d = e.S.auth.sessionLimits.decision; const T = 1e12;
  assert.equal(d(T, T - 10 * 60000, T - 3600000, cfg), 'ok');
  assert.equal(d(T, T - (29 * 60000 + 1000), T - 3600000, cfg), 'warn');
  assert.equal(d(T, T - 30 * 60000, T - 3600000, cfg), 'idle');
  assert.equal(d(T, T, T - 12 * 3600000, cfg), 'max');
  assert.equal(d(T, T - 99 * 3600000, T - 99 * 3600000, { idleMs: 0, warnMs: 0, maxMs: 0 }), 'ok');
  const e2 = makeEnv({ cfg: { auth: { session: { idleMinutes: 5, warnSeconds: 30, maxHours: 0 } } } });
  const c2 = e2.S.auth.sessionLimits.config();
  assert.equal(c2.idleMs, 5 * 60000); assert.equal(c2.warnMs, 30000); assert.equal(c2.maxMs, 0);
});
t('idle logout: after 30 min without activity → local sign-out + login?expired=1&reason=idle', async () => {
  const e = makeEnv({ path: '/quotes' });
  await e.S.init();
  e.S.auth.required();                          // page gate → starts the limits
  assert.equal(e.intervals.length, 1, 'timer started on a staff page');
  e.clock.advance(20 * 60000); e.tick();
  assert.ok(!e.calls.some((x) => x[0] === 'location.replace'), 'not yet');
  e.clock.advance(11 * 60000); e.tick();
  await flush(); await flush();
  assert.ok(e.calls.some((x) => x[0] === 'signOut' && x[1] && x[1].scope === 'local'), 'local sign-out');
  const r = e.calls.find((x) => x[0] === 'location.replace');
  assert.match(r[1], /^login\.html\?next=quotes&expired=1&reason=idle$/);
  assert.equal(e.win.localStorage.getItem('bp_session_start'), null);
});
t('activity in ANOTHER tab (shared localStorage timestamp) keeps this tab signed in', async () => {
  const e = makeEnv({ path: '/quotes' });
  await e.S.init(); e.S.auth.required();
  for (let i = 0; i < 6; i++) {               // 60 minutes, another tab active every 10
    e.clock.advance(10 * 60000);
    e.win.localStorage.setItem('bp_last_activity', String(e.clock.get()));
    e.tick();
  }
  await flush();
  assert.ok(!e.calls.some((x) => x[0] === 'location.replace'), 'still signed in');
});
t('max session age: 12 h after sign-in → signed out even when active', async () => {
  const start = Date.UTC(2026, 9, 6, 9, 0, 0);
  const e = makeEnv({ path: '/dashboard', now: start + 12 * 3600000 + 1000, ls: { bp_session_start: JSON.stringify({ uid: 'u-1', ts: start }) } });
  await e.S.init(); e.S.auth.required();
  await flush(); await flush();
  const r = e.calls.find((x) => x[0] === 'location.replace');
  assert.ok(r && /reason=max/.test(r[1]), 'max-age logout');
});
t('sign-in starts a FRESH session clock and clears per-user browser state on account change', async () => {
  const e = makeEnv({ user: null, path: '/login', ls: { bp_session_start: JSON.stringify({ uid: 'someone-else', ts: 1 }), wa_pin: 'x' } });
  await e.S.init();
  await e.S.auth.signIn('a@b.co', 'pw');
  const st = JSON.parse(e.win.localStorage.getItem('bp_session_start'));
  assert.equal(st.uid, 'u-1'); assert.equal(st.ts, e.clock.get());
  assert.equal(e.win.localStorage.getItem('wa_pin'), null, 'previous user\'s keys cleared');
});
t('no session limits on public client-link pages (approve / portal / proposal-view / invite / work)', async () => {
  for (const p of ['/approve', '/portal', '/proposal-view', '/invite', '/work', '/demo/quote/abc', '/i/slug']) {
    const e = makeEnv({ path: p });
    await e.S.init(); e.S.auth.required(); e.S.auth.sessionLimits.start();
    assert.equal(e.intervals.length, 0, p + ' must not run the idle timer');
    assert.ok(!e.calls.some((x) => x[0] === 'rpc' && x[1] === 'password_change_required'), p + ' must not run the staff gate');
  }
});
t('explicit Log out is global and clears per-user + session-clock state', async () => {
  const e = makeEnv({ ls: { bp_session_start: JSON.stringify({ uid: 'u-1', ts: 1 }), wa_pin: '1' } });
  await e.S.init();
  await e.S.auth.signOut();
  assert.deepEqual(e.calls.find((x) => x[0] === 'signOut'), ['signOut', null], 'default scope = global');
  assert.equal(e.win.localStorage.getItem('bp_session_start'), null);
  assert.equal(e.win.localStorage.getItem('wa_pin'), null);
});
t('cross-tab account switch: another user signing in elsewhere drops caches and reloads', async () => {
  const e = makeEnv({ path: '/quotes' });
  await e.S.init();
  e.emit('SIGNED_IN', { user: { id: 'u-2', email: 'other@b.co' } });
  assert.ok(e.calls.some((x) => x[0] === 'location.reload'));
  assert.match(SRC, /if \(!uid \|\| o\.uid !== uid\) return null;/, 'role / matrix cache is keyed by user id');
});

/* ------------------------------------------------ 7. Google OAuth */
t('Google sign-in: no offline access / consent prompt; implicit flow unchanged (no PKCE switch)', async () => {
  const e = makeEnv({ user: null, path: '/login' });
  await e.S.init();
  await e.S.auth.signInWithGoogle('https://www.helm.events/login.html');
  const q = e.calls.find((x) => x[0] === 'signInWithOAuth')[1].options.queryParams;
  assert.deepEqual(JSON.parse(JSON.stringify(q)), { prompt: 'select_account' });
  assert.ok(!/access_type/.test(SRC), 'no access_type anywhere');
  assert.ok(!/flowType/.test(SRC), 'flow type not changed (PKCE is a documented recommendation)');
});

/* ------------------------------------------- 8. pages + headers */
t('login.html: Forgot password view with a generic answer, two-step code view, CAPTCHA mounts', () => {
  const h = read('public/login.html');
  assert.match(h, /id="forgotBtn"/);
  assert.match(h, /If an account exists for that email, we've sent a link/);
  assert.match(h, /id="mfaForm"/);
  assert.match(h, /HelmAuthUI\.mountCaptcha\(\$\("#captcha"\)/);
  assert.match(h, /signIn\(email, pw, \{captchaToken:capToken\(cap\)\}\)/);
  assert.match(h, /if\(!\(await finishGate\(\)\)\) return;/, 'gate finished before entering the app');
  assert.ok(!/passwordChangeRequired\(\)\)\{ await forcePasswordChange/.test(h), 'old fail-open check removed');
});
t('reset-password page: exists, no inline script, external logic, noindex, no-referrer', () => {
  assert.ok(existsSync(new URL('public/reset-password.html', root)));
  const h = read('public/reset-password.html');
  assert.ok(!/<script>(?!<\/script>)/.test(h) && !/<script(?![^>]*\bsrc=)[^>]*>/.test(h), 'no inline <script>');
  assert.match(h, /<script src="reset-password\.js\?v=\d+"><\/script>/);
  assert.match(h, /<meta name="robots" content="noindex/);
  assert.match(h, /<meta name="referrer" content="no-referrer">/);
  const js = read('public/reset-password.js');
  assert.match(js, /BPStore\.auth\.updatePassword\(/);
  assert.match(js, /reverifyPassword\(/);
  assert.match(js, /location\.replace\("login\?reset=1"\)/);
});
t('vercel.json: reset-password is noindex + no-store; Turnstile CSP only on login/reset', () => {
  const v = JSON.parse(read('vercel.json'));
  const hdr = (p) => { const o = {}; for (const r of v.headers) if (new RegExp('^' + r.source + '$').test(p)) for (const x of r.headers) o[x.key.toLowerCase()] = x.value; return o; };
  for (const p of ['/reset-password', '/reset-password.html', '/login', '/dashboard', '/control.html']) {
    assert.match(hdr(p)['x-robots-tag'] || '', /noindex/, p);
    assert.equal(hdr(p)['cache-control'], 'no-store', p);
  }
  assert.match(hdr('/login')['content-security-policy'], /script-src 'self' https:\/\/challenges\.cloudflare\.com/);
  assert.match(hdr('/reset-password')['content-security-policy'], /frame-src 'self' https:\/\/challenges\.cloudflare\.com/);
  assert.ok(!/challenges\.cloudflare\.com/.test(hdr('/dashboard')['content-security-policy']));
});
t('auth-ui.js: QR is only ever an image data: URI (never a remote URL)', () => {
  const ctx = { window: {}, document: { createElement: () => ({}) } };
  ctx.window = ctx; vm.createContext(ctx);
  vm.runInContext(read('public/auth-ui.js'), ctx);
  const q = ctx.HelmAuthUI._safeQr;
  assert.match(q('data:image/svg+xml;utf-8,<svg></svg>'), /^data:image\/svg\+xml;charset=utf-8,%3Csvg/);
  assert.equal(q('https://evil.example/qr.svg'), '');
  assert.equal(q('javascript:alert(1)'), '');
});
t('DB: 0028 is in the MANIFEST; the auth-hardening suite is wired into run-all', () => {
  assert.match(read('supabase/migrations/MANIFEST'), /^forward\s+supabase\/migrations\/0028_auth_hardening\.sql$/m);
  assert.match(read('scripts/db-test/run-all.sh'), /tests\/db\/auth-hardening\.sql/);
  const m = read('supabase/migrations/0028_auth_hardening.sql');
  assert.match(m, /gen_salt\('bf', 12\)/);
  assert.match(m, /could not create this user/);
  assert.ok(!/a user with that email already exists/.test(m.replace(/^--.*$/gm, '')), 'no cross-tenant "exists" message');
});

for (const [name, fn] of tests) {
  try { await fn(); n++; console.log('ok -', name); }
  catch (e) { console.error('not ok -', name); console.error(e); process.exitCode = 1; }
}
console.log(`\nauth-session-hardening: ${n}/${tests.length} passed`);
if (n !== tests.length) process.exit(1);
