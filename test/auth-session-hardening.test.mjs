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
  let session = user ? { user, access_token: o.accessToken || 'x' } : null;
  const listeners = [];
  const supaAuth = {
    async getSession() { if (o.exchangeFails) return { data: { session: null }, error: { message: 'code verifier missing', code: 'pkce_code_verifier_not_found' } }; return { data: { session } }; },
    onAuthStateChange(cb) { listeners.push(cb); return { data: { subscription: { unsubscribe() {} } } }; },
    async signInWithPassword(arg) { calls.push(['signInWithPassword', arg]); if (o.signInError) return { data: {}, error: o.signInError }; session = { user: o.signInUser || user || { id: 'u-1', email: arg.email } }; return { data: { user: session.user, session }, error: null }; },
    async signUp(arg) { calls.push(['signUp', arg]); if (o.signUpError) return { data: {}, error: o.signUpError }; return { data: { user: { id: 'u-new' }, session: null }, error: null }; },
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
  const hist = { replaceState(a, b, u) { calls.push(['replaceState', u]); } };
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
    supabase: { createClient: (u, k, opts) => { calls.push(['createClient', opts]); return client; } },
    localStorage: memStore(o.ls), sessionStorage: memStore(o.ss),
    location: loc, history: hist, document: doc, navigator: { onLine: true },
    fetch: async () => ({ status: 200, ok: true, json: async () => ({}) }),
    addEventListener() {}, removeEventListener() {},
    setTimeout: (fn) => { try { fn(); } catch (e) {} return 0; }, clearTimeout() {},
    setInterval: (fn, ms) => { intervals.push(fn); return intervals.length; }, clearInterval: (id) => { intervals[id - 1] = null; },
    atob: (b) => Buffer.from(b, 'base64').toString('binary'),
    console, Date: FakeDate, Promise, URLSearchParams, URL, JSON, Math, Object, Array, String, Number, RegExp, Error, Map, Set,
  };
  win.window = win; win.globalThis = win;
  vm.createContext(win);
  vm.runInContext(SRC, win, { filename: 'store-api.js' });
  return { win, S: win.BPStore, calls, clock, intervals, tick: () => intervals.forEach((f) => f && f()), emit: (ev, s) => listeners.forEach((cb) => cb(ev, s)) };
}
const flush = () => new Promise((r) => setImmediate(r));
// unsigned test JWT carrying only the claims store-api reads (amr) — never a real token
const fakeJwt = (claims) => ['{"alg":"none"}', JSON.stringify(claims)].map((x) => Buffer.from(x).toString('base64url')).join('.') + '.sig';
const RECOVERY_JWT = fakeJwt({ sub: 'u-1', amr: [{ method: 'recovery', timestamp: 1 }] });
const PASSWORD_JWT = fakeJwt({ sub: 'u-1', amr: [{ method: 'password', timestamp: 1 }] });
const CAPTCHA_ON = { captcha: { provider: 'turnstile', siteKey: '0x4AAAAAAA-test-site-key' } };
const SESSION_ON = { auth: { session: { idleMinutes: 30, warnSeconds: 60, maxHours: 12 } } };

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
  assert.match(cfg, /session:\s*\{\s*idleMinutes:\s*60,\s*warnSeconds:\s*120,\s*maxHours:\s*12\s*\}/, 'idle 60 min (warning 2 min before) + 12 h absolute max');
  assert.match(cfg, /mfaRequiredForAdmins:\s*false/, 'two-step stays optional (owner decision) — documented switch');
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
  await e.S.auth.signUp('n@b.co', 'Long-password12', { captchaToken: 'tok2' });
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
t('password rule = Supabase policy: >=12 + lowercase + uppercase + digit + symbol', () => {
  const e = makeEnv({ user: null, path: '/login' });
  const R = e.S.auth.passwordRule, p = R.problem;
  assert.equal(p('Abcdefghij1!'), null);
  assert.match(p('abcdefghij12'), /uppercase letter and a symbol/);
  assert.match(p('ABCDEFGHIJ1!'), /lowercase/);
  assert.match(p('Abcdefghijk!'), /a number/);
  assert.match(p('Abcdefghij12'), /symbol/);
  assert.match(p('Abc1!'), /12 characters/);
  for (const c of "!@#$%^&*()_+-=[]{};'\\:\"|<>?,./`~") assert.equal(p('Abcdefghij1' + c), null, 'symbol ' + c);
  assert.ok(p('Abcdefghij1 '), 'space is not a Supabase symbol');
  assert.ok(p('Abcdefghij1é'), 'non-ASCII is not a Supabase symbol');
  assert.equal(R.symbols, "!@#$%^&*()_+-=[]{};'\\:\"|<>?,./`~");
  assert.deepEqual([...R.checks('Abcdefghij1!').map((c) => c.ok)], [true, true, true, true, true]);
  assert.deepEqual([...R.checks('abc').map((c) => c.id)], ['len', 'lower', 'upper', 'digit', 'symbol']);
  assert.equal(typeof R.attachChecklist, 'function');
});
t('every "set a password" screen shows the new rule text + a live checklist', () => {
  const L = read('public/login.html'), RP = read('public/reset-password.html'), RJ = read('public/reset-password.js'), AU = read('public/auth-ui.js');
  for (const [n, s] of [['login', L], ['reset-password', RP], ['auth-ui', AU]]) {
    assert.match(s, /lowercase letter, an uppercase letter, a number and a symbol/, n + ' helper text');
    assert.ok(!/with a letter and a number/.test(s), n + ' still shows the old rule');
  }
  assert.match(L, /attachChecklist\(document\.getElementById\("pw"\), document\.getElementById\("pwRules"\)\)/, 'sign-up checklist');
  assert.match(L, /attachChecklist\(pw, ov\.querySelector\("#fpc_rules"\)\)/, 'temp-password checklist');
  assert.match(RJ, /attachChecklist\(\$\("#new_pw"\), \$\("#newRules"\)\)/, 'reset / change checklist');
});
t('0030 migration: _password_ok = Supabase rule, in MANIFEST after 0028, temp passwords carry a symbol', () => {
  const m = read('supabase/migrations/0030_password_rule_symbols.sql');
  assert.match(read('supabase/migrations/MANIFEST'), /0028_auth_hardening\.sql\s*\n(?:.*\n)*forward\s+supabase\/migrations\/0030_password_rule_symbols\.sql/);
  assert.match(m, /create or replace function public\._password_ok/);
  assert.match(m, /p ~ '\[a-z\]'/); assert.match(m, /p ~ '\[A-Z\]'/); assert.match(m, /p ~ '\[0-9\]'/);
  assert.match(m, /auth-hardening-0028/, 'keeps the 0028 marker so 0028 re-runs stay no-ops');
  assert.match(m, /v_sym text := '!#%\*-_\+=\?'/);
  assert.ok(!/\b(drop|delete|truncate)\b/i.test(m.replace(/--.*$/gm, '')), 'additive only');
});
t('password rule: weak passwords never reach Supabase (signup / change / admin create)', async () => {
  const e = makeEnv({ user: null, path: '/login' });
  const p = e.S.auth.passwordRule.problem;
  assert.ok(p('short1'));
  assert.ok(p('abcdefghijklmnop'));
  assert.ok(p('123456789012345'));
  assert.ok(p('abcdefghij12'), 'old letter+digit rule no longer enough');
  assert.equal(p('Abcdefghij1!'), null);
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
t('a legacy implicit recovery fragment is NOT forwarded or used (PKCE only; see 7b)', async () => {
  const e = makeEnv({ user: null, path: '/', hash: '#access_token=a&refresh_token=b&type=recovery' });
  e.S.init();
  await flush();
  assert.ok(!e.calls.some((x) => x[0] === 'location.replace' && /access_token/.test(x[1])));
});
t('an unfinished reset keeps the app closed (pending "recovery") until the new password is set', async () => {
  const e = makeEnv({ path: '/dashboard', ls: { bp_recovery_pending: 'u-1' }, accessToken: RECOVERY_JWT });
  await e.S.init();
  assert.equal(e.S.auth.pendingStep(), 'recovery');
  assert.equal(e.S.auth.user(), null);
  assert.equal(e.S.auth.required(), true);
  await e.S.auth.updatePassword('New-password123');
  assert.equal(e.win.localStorage.getItem('bp_recovery_pending'), null);
  assert.ok(e.calls.some((x) => x[0] === 'signOut' && x[1] && x[1].scope === 'others'), 'other sessions signed out');
});

/* ------------------------- 3b. password CHANGE needs the current password */
const updates = (e) => e.calls.filter((x) => x[0] === 'updateUser');
t('change password: updatePassword without a fresh current-password check is refused (no request)', async () => {
  const e = makeEnv({ accessToken: PASSWORD_JWT });
  await e.S.init();
  await assert.rejects(e.S.auth.updatePassword('Brand-new-pass12'), (x) => x.code === 'reauth_required');
  assert.equal(updates(e).length, 0, 'updateUser never called');
});
t('change password: a WRONG current password fails closed with one generic message and grants nothing', async () => {
  const e = makeEnv({ accessToken: PASSWORD_JWT, signInError: { status: 400, message: 'Invalid login credentials' } });
  await e.S.init();
  await assert.rejects(e.S.auth.reverifyPassword('wrong-one'), (x) => x.code === 'bad_current_password' && x.message === "Your current password isn't right.");
  await assert.rejects(e.S.auth.reverifyPassword(''), (x) => x.code === 'bad_current_password');
  await assert.rejects(e.S.auth.updatePassword('Brand-new-pass12'), (x) => x.code === 'reauth_required');
  assert.equal(updates(e).length, 0);
});
t('change password: re-sign-in uses the user\'s OWN email; then one change is allowed and carries current_password', async () => {
  const e = makeEnv({ accessToken: PASSWORD_JWT });
  await e.S.init();
  await e.S.auth.reverifyPassword('Old-password12!');
  const si = e.calls.filter((x) => x[0] === 'signInWithPassword').pop();
  assert.equal(si[1].email, 'staff@a.test');
  // prod requires the current password: without it nothing is sent (proof not consumed)
  await assert.rejects(e.S.auth.updatePassword('Brand-new-pass12!'), (x) => x.code === 'current_password_required');
  assert.equal(updates(e).length, 0, 'the password kept by reverify is NOT reused');
  const opts = { currentPassword: 'Old-password12!' };
  await e.S.auth.updatePassword('Brand-new-pass12!', opts);
  assert.deepEqual(JSON.parse(JSON.stringify(updates(e)[0][1])), { password: 'Brand-new-pass12!', current_password: 'Old-password12!' });
  assert.equal(opts.currentPassword, null, 'caller copy cleared after use');
  await assert.rejects(e.S.auth.updatePassword('Another-pass12!', { currentPassword: 'x' }), (x) => x.code === 'reauth_required', 'proof is single-use');
  assert.equal(updates(e).length, 1);
});
t('change password: the current-password proof expires after 10 minutes', async () => {
  const e = makeEnv({ accessToken: PASSWORD_JWT });
  await e.S.init();
  await e.S.auth.reverifyPassword('Old-password12!');
  e.clock.advance(10 * 60 * 1000 + 1);
  await assert.rejects(e.S.auth.updatePassword('Brand-new-pass12!'), (x) => x.code === 'reauth_required');
  assert.equal(updates(e).length, 0);
});
t('change password: the current password is never retained in memory after re-verification', async () => {
  const src = readFileSync(new URL('../public/store-api.js', import.meta.url), 'utf8');
  assert.ok(!/reauth\s*=\s*\{[^}]*\bpw\s*:/.test(src), 'reauth proof must not hold the password');
  assert.ok(!/reauth\.pw/.test(src));
  const e = makeEnv({ accessToken: PASSWORD_JWT });
  await e.S.init();
  await e.S.auth.reverifyPassword('Old-password12!');
  // explicit, single-use pass-through when the Supabase "require current password" setting is on
  await e.S.auth.updatePassword('Brand-new-pass12!', { currentPassword: 'Old-password12!' });
  assert.deepEqual(JSON.parse(JSON.stringify(updates(e)[0][1])), { password: 'Brand-new-pass12!', current_password: 'Old-password12!' });
});
t('change password: a re-sign-in that returns a DIFFERENT account is refused', async () => {
  const e = makeEnv({ accessToken: PASSWORD_JWT, signInUser: { id: 'u-OTHER', email: 'staff@a.test' } });
  await e.S.init();
  await assert.rejects(e.S.auth.reverifyPassword('Old-password12!'), (x) => x.code === 'bad_current_password');
  await assert.rejects(e.S.auth.updatePassword('Brand-new-pass12!'), (x) => x.code === 'reauth_required');
});
t('reset link: only a session whose signed token says amr=recovery may skip the current password', async () => {
  // spoofed marker (anyone can open /reset-password#type=recovery or set localStorage)
  const spoof = makeEnv({ path: '/reset-password', ls: { bp_recovery_pending: 'u-1' }, accessToken: PASSWORD_JWT });
  await spoof.S.init();
  assert.equal(await spoof.S.auth.isRecoverySession(), false);
  await assert.rejects(spoof.S.auth.updatePassword('Brand-new-pass12!'), (x) => x.code === 'reauth_required');
  assert.equal(updates(spoof).length, 0);
  const junk = makeEnv({ path: '/reset-password', accessToken: 'not.a.jwt' }); await junk.S.init();
  assert.equal(await junk.S.auth.isRecoverySession(), false, 'undecodable token → fail closed');
  const real = makeEnv({ path: '/reset-password', accessToken: RECOVERY_JWT });
  await real.S.init();
  assert.equal(await real.S.auth.isRecoverySession(), true);
  await real.S.auth.updatePassword('Brand-new-pass12!');
  assert.deepEqual(JSON.parse(JSON.stringify(updates(real)[0][1])), { password: 'Brand-new-pass12!' });
});
t('Google-only account: no password to confirm — refused before any request; UI says so', async () => {
  const g = { id: 'u-1', email: 'g@a.test', app_metadata: { provider: 'google', providers: ['google'] }, identities: [{ provider: 'google' }] };
  const e = makeEnv({ user: g, accessToken: PASSWORD_JWT });
  await e.S.init();
  assert.equal(e.S.auth.hasPassword(), false);
  await assert.rejects(e.S.auth.reverifyPassword('anything'), (x) => x.code === 'bad_current_password');
  assert.ok(!e.calls.some((x) => x[0] === 'signInWithPassword'));
  const both = makeEnv({ user: { id: 'u-1', email: 'b@a.test', app_metadata: { providers: ['email', 'google'] }, identities: [{ provider: 'email' }, { provider: 'google' }] } });
  await both.S.init();
  assert.equal(both.S.auth.hasPassword(), true, 'email+google account keeps its password');
  assert.match(read('public/auth-ui.js'), /hasPassword\(\)/);
  assert.match(read('public/reset-password.js'), /hasPassword\(\)/);
});
t('forced temp-password change only runs while the server flags the account (pendingStep "password")', async () => {
  const e = makeEnv({ accessToken: PASSWORD_JWT });
  await e.S.init();
  assert.equal(e.S.auth.pendingStep(), null);
  await assert.rejects(e.S.auth.completePasswordChange('Brand-new-pass12!'), (x) => x.code === 'reauth_required');
  assert.equal(updates(e).length, 0);
});
t('reset-password.js trusts the signed recovery session, not the "#type=recovery" fragment alone', () => {
  const js = read('public/reset-password.js');
  assert.match(js, /isRecoverySession\(\)/);
  assert.match(js, /recovering = realRecovery;/);
  assert.ok(!/recovering = RECOVERY_LINK \|\|/.test(js), 'fragment alone must not skip the current-password step');
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
t('reset link (recovery session): password set WITHOUT a current password — none sent, none required', async () => {
  const e = makeEnv({ path: '/reset-password', ls: { bp_recovery_pending: 'u-1' }, accessToken: RECOVERY_JWT });
  await e.S.init();
  await e.S.auth.updatePassword('Recovered-pass12!');
  const u = updates(e);
  assert.equal(u.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(u[0][1])), { password: 'Recovered-pass12!' });
});
t('Supabase rejecting the current password maps to one generic message', async () => {
  const e = makeEnv({ accessToken: PASSWORD_JWT, updateError: { message: 'Current password required', code: 'current_password_mismatch' } });
  await e.S.init();
  await e.S.auth.reverifyPassword('Old-password12!');
  await assert.rejects(e.S.auth.updatePassword('Brand-new-pass12!', { currentPassword: 'nope' }), (x) => x.code === 'bad_current_password');
});
t('UI wiring: change form + forced temp-password form collect the current password and pass it once', () => {
  const rp = readFileSync(new URL('../public/reset-password.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../public/reset-password.html', import.meta.url), 'utf8');
  const login = readFileSync(new URL('../public/login.html', import.meta.url), 'utf8');
  assert.match(html, /id="set_cur_pw"[^>]*autocomplete="current-password"/);
  assert.match(rp, /recovering \? undefined : \{ currentPassword: \$\("#set_cur_pw"\)\.value \}/);
  assert.match(rp, /updatePassword\(a, opts\)/);
  assert.match(rp, /\$\("#set_cur_pw"\)\.value = ""/);
  assert.match(login, /id="fpc_cur" type="password" autocomplete="current-password"/);
  assert.match(login, /completePasswordChange\(pw\.value, opts\)/);
  assert.match(login, /opts\.currentPassword=null/);
});
t('temp password: a failed flag clear is an error, not ignored; retry does not re-send the password', async () => {
  let fail = true;
  const e = makeEnv({ rpc: { password_change_required: { data: true, error: null }, clear_password_change_required: () => (fail ? { data: null, error: { message: 'set a new password first' } } : { data: null, error: null }) } });
  await e.S.init();
  await assert.rejects(e.S.auth.completePasswordChange('Brand-new-pass12'), (x) => x.code === 'current_password_required');
  assert.equal(e.calls.filter((x) => x[0] === 'updateUser').length, 0, 'nothing sent without the temporary password');
  const o1 = { currentPassword: 'Temp-pass-1234!' };
  await assert.rejects(e.S.auth.completePasswordChange('Brand-new-pass12', o1));
  assert.equal(o1.currentPassword, null, 'caller copy cleared');
  const sent = e.calls.filter((x) => x[0] === 'updateUser');
  assert.equal(sent.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(sent[0][1])), { password: 'Brand-new-pass12', current_password: 'Temp-pass-1234!' }, 'temp password sent as current_password');
  fail = false;
  e.win.SUPABASE_CONFIG.__x = 1;
  await e.S.auth.completePasswordChange('Brand-new-pass12');
  assert.equal(e.calls.filter((x) => x[0] === 'updateUser').length, 1, 'password not re-sent on retry');
  await assert.rejects(e.S.auth.completePasswordChange('short'), /12 characters/);
});

/* ---------------------------------------------- 6. session limits */
t('session defaults: idle + max-age logout are OFF (0) unless config turns them on', () => {
  const d0 = makeEnv().S.auth.sessionLimits.config();
  assert.equal(d0.idleMs, 0); assert.equal(d0.maxMs, 0); assert.equal(d0.warnMs, 60000);
  const T = 1e12;
  assert.equal(makeEnv().S.auth.sessionLimits.decision(T, T - 30 * 24 * 3600000, T - 30 * 24 * 3600000, d0), 'ok', '30 days idle → still signed in');
});
t('session decision (when enabled): 30 min idle (60 s warning) and 12 h max; 0 turns a limit off', () => {
  const e = makeEnv({ cfg: SESSION_ON });
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
t('committed config: 60 min idle with the warning 2 min before, 12 h absolute max', () => {
  const e = makeEnv({ cfg: { auth: { session: { idleMinutes: 60, warnSeconds: 120, maxHours: 12 } } } });
  const cfg = e.S.auth.sessionLimits.config(); const d = e.S.auth.sessionLimits.decision; const T = 1e12;
  assert.equal(d(T, T - 57 * 60000, T - 3600000, cfg), 'ok');
  assert.equal(d(T, T - 58 * 60000, T - 3600000, cfg), 'warn');
  assert.equal(d(T, T - 60 * 60000, T - 3600000, cfg), 'idle');
  assert.equal(d(T, T, T - 12 * 3600000, cfg), 'max');
});
t('idle logout: after 30 min without activity → local sign-out + login?expired=1&reason=idle', async () => {
  const e = makeEnv({ path: '/quotes', cfg: SESSION_ON });
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
  const e = makeEnv({ path: '/quotes', cfg: SESSION_ON });
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
  const e = makeEnv({ path: '/dashboard', cfg: SESSION_ON, now: start + 12 * 3600000 + 1000, ls: { bp_session_start: JSON.stringify({ uid: 'u-1', ts: start }) } });
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
t('Google sign-in: no offline access / consent prompt; returns to login with ?code= (PKCE)', async () => {
  const e = makeEnv({ user: null, path: '/login' });
  await e.S.init();
  await e.S.auth.signInWithGoogle('https://www.helm.events/login.html');
  const q = e.calls.find((x) => x[0] === 'signInWithOAuth')[1].options.queryParams;
  assert.deepEqual(JSON.parse(JSON.stringify(q)), { prompt: 'select_account' });
  assert.ok(!/access_type/.test(SRC), 'no access_type anywhere');
});

/* ------------------------------------------------ 7b. PKCE flow */
t('PKCE: createClient uses flowType "pkce" + detectSessionInUrl (code exchange on return)', async () => {
  const e = makeEnv({ user: null, path: '/login' });
  await e.S.init();
  const opts = e.calls.find((x) => x[0] === 'createClient')[1].auth;
  assert.equal(opts.flowType, 'pkce');
  assert.equal(opts.detectSessionInUrl, true);
  assert.match(SRC, /flowType: "pkce"/);
  assert.ok(!/flowType: "implicit"/.test(SRC));
});
t('PKCE: ?code= exchanged → session, code removed from the address bar, no link error', async () => {
  const e = makeEnv({ path: '/login.html', search: '?code=abc&next=dashboard' });
  await e.S.init();
  assert.equal(e.S.auth.linkReturned(), true);
  assert.equal(e.S.auth.linkError(), '');
  const r = e.calls.find((x) => x[0] === 'replaceState');
  assert.ok(r && !/code=/.test(r[1]) && /next=dashboard/.test(r[1]), 'code stripped, other params kept');
});
t('PKCE: ?code= that cannot be exchanged (other browser) → linkError, pages explain "same browser"', async () => {
  const e = makeEnv({ user: null, path: '/reset-password', search: '?code=abc', exchangeFails: true });
  await e.S.init();
  assert.equal(e.S.auth.pendingUser(), null);
  assert.equal(e.S.auth.linkError(), 'pkce_exchange_failed');
  assert.match(read('public/reset-password.js'), /Open the link in the same browser you requested it from/);
  assert.match(read('public/login.html'), /Open the link in the same browser you requested it from/);
});
t('PKCE: tokens are never read from the URL fragment (legacy #access_token is stripped)', async () => {
  const e = makeEnv({ user: null, path: '/login', hash: '#access_token=AAA&refresh_token=BBB&type=recovery' });
  await e.S.init();
  assert.ok(e.calls.some((x) => x[0] === 'replaceState' && !/access_token/.test(x[1])));
  assert.ok(!e.calls.some((x) => x[0] === 'location.replace' && /access_token/.test(x[1])), 'fragment not forwarded anywhere');
  const rp = read('public/reset-password.js');
  assert.ok(!/location\.hash/.test(rp), 'reset page reads ?code=, not the fragment');
  assert.match(rp, /qp\.get\("code"\)/);
});
t('PKCE: a recovery code that lands on another page is sent to /reset-password', async () => {
  const e = makeEnv({ path: '/login.html', search: '?code=abc', accessToken: RECOVERY_JWT });
  e.S.init();
  await flush(); await flush();
  assert.ok(e.calls.some((x) => x[0] === 'location.replace' && x[1] === '/reset-password'));
});
t('sign-up sends emailRedirectTo (confirm link returns with ?code= to the sign-in page)', async () => {
  const e = makeEnv({ user: null, path: '/login' });
  await e.S.init();
  await e.S.auth.signUp('n@b.co', 'Long-password12!');
  assert.equal(e.calls.find((x) => x[0] === 'signUp')[1].options.emailRedirectTo, 'https://www.helm.events/login.html');
  assert.match(read('public/login.html'), /emailRedirectTo:confirmRedirect\(\)/);
});

/* ------------------------------------- 7c. no account enumeration */
t('enumeration: wrong password / unknown email / unconfirmed email → the same generic sign-in error', async () => {
  for (const err of [{ message: 'Invalid login credentials', code: 'invalid_credentials', status: 400 },
                     { message: 'Email not confirmed', code: 'email_not_confirmed', status: 400 },
                     { message: 'User not found', status: 400 }]) {
    const e = makeEnv({ user: null, path: '/login', signInError: err });
    await e.S.init();
    await assert.rejects(e.S.auth.signIn('a@b.co', 'pw'), (x) => x.message === 'Invalid email or password.' && x.code === 'invalid_credentials');
  }
  const e = makeEnv({ user: null, path: '/login', signInError: { message: 'Too many requests', status: 429 } });
  await e.S.init();
  await assert.rejects(e.S.auth.signIn('a@b.co', 'pw'), (x) => /Too many/.test(x.message), 'rate limit still explained');
});
t('enumeration: sign-up of an existing email looks exactly like a new one (generic "sent")', async () => {
  const a = makeEnv({ user: null, path: '/login', signUpError: { message: 'User already registered', code: 'user_already_exists', status: 422 } });
  await a.S.init();
  const ra = await a.S.auth.signUp('x@b.co', 'Long-password12!');
  const b = makeEnv({ user: null, path: '/login' });
  await b.S.init();
  const rb = await b.S.auth.signUp('y@b.co', 'Long-password12!');
  assert.deepEqual(JSON.parse(JSON.stringify(ra)), JSON.parse(JSON.stringify(rb)));
  assert.equal(ra.generic, "If this email can be used, we've sent a link. It can take a few minutes — check spam too.");
});
t('enumeration: reset for unknown email resolves like a known one; login page shows one message', async () => {
  const e = makeEnv({ user: null, path: '/login', resetError: { message: 'User not found', status: 400 } });
  await e.S.init();
  assert.equal(await e.S.auth.requestPasswordReset('nobody@b.co'), true);
  const h = read('public/login.html');
  assert.match(h, /\$\("#fgOk"\)\.textContent=BPStore\.auth\.genericMessages\.sent/);
  assert.ok(!/already registered\|email/.test(h), 'login no longer echoes "already registered"');
  assert.ok(!/Account created\. Confirm/.test(h));
});

/* ------------------------------------------- 8. pages + headers */
t('login.html: Forgot password view with a generic answer, two-step code view, CAPTCHA mounts', () => {
  const h = read('public/login.html');
  assert.match(h, /id="forgotBtn"/);
  assert.match(h, /genericMessages\.sent/);
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
