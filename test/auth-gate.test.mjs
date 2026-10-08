// Auth gate (owner bugs, Oct 2026): no signed-in page may paint before auth is
// confirmed; sign-in decides studio / HQ / onboarding BEFORE any app page shows;
// every auth redirect uses location.replace (no Back-button loop); ?next= is
// same-site only. Static page checks + public/store-api.js run in a vm sandbox
// with a stub Supabase client (no network, no real credentials).
import { readFileSync, readdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const root = new URL('..', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
const SRC = read('public/store-api.js');
const tests = [];
const t = (name, fn) => tests.push([name, fn]);

// Pages anyone may open without a studio session. Everything else is protected
// (default-deny: a NEW page must either get the gate or be added here on purpose).
const PUBLIC = ['index', 'about', 'services', 'privacy', 'terms', 'refund-policy', 'login', 'reset-password',
  'approve', 'portal', 'booklet', 'proposal-view', 'work', 'invite', 'sim-pay', '404', 'manual', 'hq'];
const PAGES = readdirSync(new URL('public/', root)).filter((f) => f.endsWith('.html')).map((f) => f.slice(0, -5));
const PROTECTED = PAGES.filter((p) => !PUBLIC.includes(p));
const GATE_CSS = /<style[^>]*>[^<]*html\.auth-pending body[^{]*\{[^}]*visibility:\s*hidden/;

/* ------------------------------------------------------------ sandbox */
function memStore(init) {
  const m = new Map(Object.entries(init || {}));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _m: m };
}
function makeEnv(o = {}) {
  const calls = [];
  const user = o.user === null ? null : (o.user || { id: 'u-1', email: 'staff@a.test' });
  let session = user ? { user, access_token: 'x' } : null;
  const winListeners = {};
  const cls = new Set(o.gated === false ? [] : ['auth-pending']);
  const client = {
    auth: {
      async getSession() { return { data: { session } }; },
      onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; },
      async refreshSession() { return { data: { session }, error: session ? null : { message: 'no' } }; },
      async signOut() { session = null; return { error: null }; },
      mfa: { async getAuthenticatorAssuranceLevel() { return { data: o.aal || { currentLevel: 'aal1', nextLevel: 'aal1' }, error: null }; } },
    },
    async rpc(name, args) {
      calls.push(['rpc', name]);
      const r = (o.rpc || {})[name];
      if (typeof r === 'function') return r(args);
      if (r) return r;
      return { data: null, error: null };
    },
    from() { const q = { select: () => q, eq: () => q, order: () => q, single: async () => ({ data: { role: 'sales' }, error: null }) }; return q; },
  };
  const loc = { pathname: o.path || '/dashboard', search: o.search || '', hash: '', origin: 'https://www.helm.events', href: '', hostname: 'www.helm.events',
    replace(u) { calls.push(['location.replace', u]); }, reload() { calls.push(['location.reload']); } };
  const body = { children: [], appendChild(c) { this.children.push(c); }, removeChild(c) { this.children = this.children.filter((x) => x !== c); }, get firstChild() { return this.children[0] || null; }, insertBefore() {} };
  const el = (tag) => ({ tag, style: {}, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, appendChild() {}, addEventListener() {}, querySelector: () => null, remove() {}, set src(v) {}, get src() { return ''; } });
  const doc = {
    readyState: 'complete', addEventListener() {}, removeEventListener() {}, currentScript: { src: 'https://www.helm.events/store-api.js?v=1' },
    createElement: el, head: { appendChild() {} }, body,
    documentElement: { setAttribute() {}, getAttribute() { return 'light'; },
      classList: { contains: (c) => cls.has(c), add: (c) => { cls.add(c); calls.push(['hide']); }, remove: (c) => { cls.delete(c); calls.push(['reveal']); } } },
    querySelector: () => null, querySelectorAll: () => [], getElementById: () => null,
  };
  const win = {
    SUPABASE_CONFIG: Object.assign({ url: 'https://abcdefghijklmnopqrst.supabase.co', anonKey: 'anon' }, o.cfg || {}),
    supabase: o.noLib ? undefined : { createClient: () => client },
    localStorage: memStore(), sessionStorage: memStore(o.ss),
    location: loc, document: doc, navigator: { onLine: true },
    fetch: async () => ({ ok: false, status: 503, json: async () => ({}) }),   // no local API server
    addEventListener(ev, fn) { (winListeners[ev] = winListeners[ev] || []).push(fn); }, removeEventListener() {},
    setTimeout: (fn, ms) => { if (!ms || ms < 1000) { try { fn(); } catch (e) {} } else if (o.allTimers) setImmediate(fn); return 0; }, clearTimeout() {},
    setInterval: () => 0, clearInterval() {},
    atob: (b) => Buffer.from(b, 'base64').toString('binary'),
    console: { log() {}, info() {}, warn() {}, error() {} }, Date, Promise, URLSearchParams, URL, JSON, Math, Object, Array, String, Number, RegExp, Error, Map, Set,
  };
  win.window = win; win.globalThis = win;
  vm.createContext(win);
  vm.runInContext(SRC, win, { filename: 'store-api.js' });
  return {
    win, S: win.BPStore, calls, gated: () => cls.has('auth-pending'),
    replaced: () => calls.filter((c) => c[0] === 'location.replace').map((c) => c[1]),
    rpcs: () => calls.filter((c) => c[0] === 'rpc').map((c) => c[1]),
    fire: (ev, arg) => (winListeners[ev] || []).forEach((f) => f(arg)),
    endSession: () => { session = null; },
  };
}
const flush = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
// init() on a redirecting gate never resolves (the page's own code must not run)
const settles = async (p) => { let done = false; p.then(() => { done = true; }, () => { done = true; }); await flush(); return done; };
const ORG = { current_org_id: { data: 'org-1', error: null } };

/* --------------------------------------------- 1. static page wiring */
t('every protected page ships <html class="auth-pending"> + a head rule hiding <body>', () => {
  assert.ok(PROTECTED.length >= 30, 'found ' + PROTECTED.length + ' protected pages');
  for (const p of PROTECTED) {
    const h = read('public/' + p + '.html');
    assert.match(h, /<html\b[^>]*\bclass="[^"]*\bauth-pending\b[^"]*"/, p + ': <html> must carry class="auth-pending" statically (before first paint)');
    const head = h.slice(0, h.indexOf('<body'));
    assert.match(head, GATE_CSS, p + ': head must hide body while html.auth-pending');
    assert.ok(/store-api\.js/.test(h) || /builder\.js/.test(h), p + ': loads store-api.js (which lifts the gate)');
  }
});
t('protected set includes the dashboard and every signed-in studio page', () => {
  for (const p of ['dashboard', 'quotes', 'flow', 'event', 'builder', 'design', 'control', 'chat', 'staff', 'settlement', 'invite-studio', 'profile-setup'])
    assert.ok(PROTECTED.includes(p), p + ' must be protected');
});
t('profile-setup (0041) is protected but can never be a ?next= target (no redirect loop)', async () => {
  assert.ok(PROTECTED.includes('profile-setup'));
  const S = makeEnv({ user: null, path: '/login', gated: false }).S;
  for (const raw of ['profile-setup', '/profile-setup', 'profile-setup.html', 'profile-setup?next=dashboard'])
    assert.equal(S.auth.safeNext(raw), 'dashboard.html', raw);
  // signed out on /profile-setup → login (like every protected page)
  const out = makeEnv({ user: null, path: '/profile-setup', search: '?next=quotes' });
  assert.equal(await settles(out.S.init()), false);
  assert.deepEqual(out.replaced(), ['/login?next=' + encodeURIComponent('profile-setup?next=quotes')]);
  // a member who must complete it: /profile-setup itself is shown, never redirected to itself
  const req = { data: { complete: false, required: true, nudge: false }, error: null };
  const e = makeEnv({ path: '/profile-setup', search: '?next=quotes.html', rpc: { ...ORG, my_profile_status: req } });
  assert.equal(await e.S.init(), 'supabase');
  assert.deepEqual(e.replaced(), []);
  assert.equal(e.gated(), false);
});
t('NO public page carries the gate (index, about, login, token pages, 404, manual, hq …)', () => {
  for (const p of PUBLIC) {
    if (!PAGES.includes(p)) continue;
    const h = read('public/' + p + '.html');
    assert.doesNotMatch(h, /auth-pending/, p + ' must not be gated');
  }
});

/* ------------------------------------------------ 2. store-api gate */
t('signed out on a protected page: stays hidden, location.replace("/login?next=…"), page code never runs', async () => {
  const e = makeEnv({ user: null, path: '/quotes', search: '?q=1' });
  const resolved = await settles(e.S.init());
  assert.equal(resolved, false, 'init() must not resolve while redirecting');
  assert.deepEqual(e.replaced(), ['/login?next=' + encodeURIComponent('quotes?q=1')]);
  assert.equal(e.gated(), true, 'body stays hidden');
  assert.ok(!e.calls.some((c) => c[0] === 'reveal'));
});
t('the gate starts by itself on a protected page (does not depend on page boot code)', async () => {
  const e = makeEnv({ user: null, path: '/dashboard' });
  await flush();
  assert.deepEqual(e.replaced(), ['/login?next=dashboard']);
});
t('a pending sign-in step (two-step code) counts as signed out → login, hidden', async () => {
  const e = makeEnv({ path: '/dashboard', aal: { currentLevel: 'aal1', nextLevel: 'aal2' } });
  assert.equal(await settles(e.S.init()), false);
  assert.deepEqual(e.replaced(), ['/login?next=dashboard']);
  assert.equal(e.gated(), true);
});
t('signed in with a studio: revealed only after session + studio check; HQ never asked', async () => {
  const e = makeEnv({ path: '/dashboard', rpc: ORG });
  assert.equal(await e.S.init(), 'supabase');
  assert.equal(e.gated(), false);
  assert.deepEqual(e.replaced(), []);
  assert.ok(e.rpcs().includes('current_org_id'));
  assert.ok(!e.rpcs().includes('is_platform_admin'), 'is_platform_admin is only asked when there is no studio');
});
t('signed in, NO studio, not an operator: replace → onboarding on /login (never shows the page)', async () => {
  const e = makeEnv({ path: '/dashboard', rpc: { is_platform_admin: { data: false, error: null } } });
  assert.equal(await settles(e.S.init()), false);
  assert.deepEqual(e.replaced(), ['/login?next=' + encodeURIComponent('dashboard.html')]);
  assert.equal(e.gated(), true);
});
t('signed in, NO studio, platform operator: replace → /hq from any studio page', async () => {
  for (const path of ['/dashboard', '/quotes', '/control.html']) {
    const e = makeEnv({ path, user: { id: 'op-1', email: 'admin@helm.events' }, rpc: { is_platform_admin: { data: true, error: null } } });
    assert.equal(await settles(e.S.init()), false);
    assert.deepEqual(e.replaced(), ['/hq'], path);
    assert.equal(e.gated(), true);
  }
});
t('is_platform_admin erroring counts as "no" → onboarding, never HQ', async () => {
  const e = makeEnv({ path: '/dashboard', rpc: { is_platform_admin: { data: null, error: { code: 'PGRST202', message: 'missing' } } } });
  await settles(e.S.init());
  assert.deepEqual(e.replaced(), ['/login?next=dashboard.html']);
  const e2 = makeEnv({ path: '/dashboard', rpc: { is_platform_admin: () => { throw new Error('network'); } } });
  await settles(e2.S.init());
  assert.deepEqual(e2.replaced(), ['/login?next=dashboard.html']);
});
t('studio lookup FAILING (network) is not "no studio": no onboarding bounce, app stays hidden, retry notice', async () => {
  const e = makeEnv({ path: '/dashboard', rpc: { current_org_id: { data: null, error: { message: 'Failed to fetch' } } } });
  assert.equal(await settles(e.S.init()), false);
  assert.deepEqual(e.replaced(), [], 'no onboarding / HQ redirect on an unknown answer');
  assert.ok(!e.rpcs().includes('is_platform_admin'));
  assert.equal(e.win.document.body.children.length, 1);
  assert.equal(e.win.document.body.children[0].attrs.role, 'alert');
  await assert.rejects(e.S.org.resolveId());
  assert.equal(await e.S.org.id(), null, 'org.id() keeps its lenient contract');
});
t('server rejects the token on the studio lookup (stale / forged local session): hidden → login', async () => {
  const e = makeEnv({ path: '/quotes', rpc: { current_org_id: { data: null, error: { code: 'PGRST301', message: 'JWT expired' } } } });
  assert.equal(await settles(e.S.init()), false);
  assert.ok(e.replaced().includes('/login?next=quotes'));
  assert.equal(e.gated(), true);
});
t('Supabase configured but its client cannot load: protected page never falls back to the app', async () => {
  const e = makeEnv({ user: null, path: '/dashboard', noLib: true, allTimers: true });   // the 8 s library-load timeout elapses
  assert.equal(await settles(e.S.init()), false, 'page code never runs');
  assert.deepEqual(e.replaced(), []);
  const kids = e.win.document.body.children;
  assert.equal(kids.length, 1, 'the app markup is removed; only the retry notice remains');
  assert.equal(kids[0].attrs.role, 'alert');
  assert.equal(e.S.mode(), 'local');
});
t('no accounts configured (local/offline dev): protected page is shown as before', async () => {
  const e = makeEnv({ user: null, path: '/dashboard', noLib: true, cfg: { url: '', anonKey: '' } });
  assert.equal(await e.S.init(), 'local');
  assert.equal(e.gated(), false);
});
t('public pages are untouched: no gate, no redirect, no studio/HQ lookups', async () => {
  for (const path of ['/', '/about', '/login', '/approve', '/portal', '/invite', '/hq']) {
    const e = makeEnv({ user: null, path, gated: false });
    assert.equal(await e.S.init(), 'supabase', path);
    assert.deepEqual(e.replaced(), [], path);
    assert.ok(!e.rpcs().includes('current_org_id') && !e.rpcs().includes('is_platform_admin'), path);
  }
});
t('Back/Forward (bfcache restore) after the session ended: hidden again + replace → login', async () => {
  const e = makeEnv({ path: '/dashboard', rpc: ORG });
  await e.S.init();
  assert.equal(e.gated(), false);
  e.endSession();
  e.fire('pageshow', { persisted: true });
  await flush();
  assert.equal(e.gated(), true);
  assert.deepEqual(e.replaced(), ['/login?next=dashboard']);
});
t('bfcache restore with the session still valid: shown again, no redirect', async () => {
  const e = makeEnv({ path: '/dashboard', rpc: ORG });
  await e.S.init();
  e.fire('pageshow', { persisted: true });
  await flush();
  assert.equal(e.gated(), false);
  assert.deepEqual(e.replaced(), []);
});
t('studio id is cached per tab per user (no extra round-trip on every navigation)', async () => {
  const e = makeEnv({ path: '/dashboard', rpc: ORG });
  await e.S.init();
  assert.equal(e.win.JSON.parse(e.win.sessionStorage.getItem('bp_sess_org')).val, 'org-1');
  const other = makeEnv({ path: '/dashboard', user: { id: 'u-2', email: 'b@a.test' }, ss: { bp_sess_org: JSON.stringify({ ts: Date.now(), uid: 'u-1', val: 'org-1' }) }, rpc: { is_platform_admin: { data: false, error: null } } });
  await settles(other.S.init());
  assert.ok(other.rpcs().includes('current_org_id'), "another user's cached studio is ignored");
  assert.deepEqual(other.replaced(), ['/login?next=dashboard.html']);
});

/* -------------------------------------------- 3. ?next= sanitiser */
t('safeNext: only the app\'s own pages (with their query) are allowed', () => {
  const S = makeEnv({ user: null, path: '/login', gated: false }).S;
  const ok = { 'dashboard': 'dashboard.html', 'quotes.html': 'quotes.html', '/flow?quote=abc': 'flow.html?quote=abc',
    'FLOW.html?quote=a b': 'flow.html?quote=a+b', 'chat': 'chat.html', 'builder?id=1&x=2': 'builder.html?id=1&x=2' };
  for (const [raw, want] of Object.entries(ok)) assert.equal(S.auth.safeNext(raw), want, raw);
  const evil = ['//evil.com', 'https://evil.com', 'http://evil.com/dashboard', '/\\evil.com', '\\\\evil.com', '\\/evil.com',
    'javascript:alert(1)', 'data:text/html,x', '//evil.com/dashboard', '%2F%2Fevil.com', '/%2Fevil.com', 'dashboard@evil.com',
    'dashboard.html#//evil', 'dashboard/../../evil', 'evil.com', 'hq', '/hq', 'login', 'index', '', null, undefined, 42,
    ' dashboard', 'dashboard\n//evil.com', '/dashboard//evil.com', 'https:dashboard', './/evil.com'];
  for (const raw of evil) assert.equal(S.auth.safeNext(raw), 'dashboard.html', String(raw));
  for (const raw of evil.filter((x) => typeof x === 'string')) {
    const out = S.auth.safeNext(raw);
    assert.ok(!/^(\/\/|[a-z]+:|\\)/i.test(out) && !out.includes('evil'), raw + ' → ' + out);
  }
});

/* ------------------------------------------------- 4. login.html flow */
t('login.html: ?next= goes through the shared sanitiser; no own page/regex parsing', () => {
  const h = read('public/login.html');
  assert.match(h, /const nextUrl=\(\)=>BPStore\.auth\.safeNext\(new URLSearchParams\(location\.search\)\.get\("next"\)/);
  assert.doesNotMatch(h, /NEXT_PAGES/);
});
t('login.html: every navigation in the auth flow uses location.replace (no history entries)', () => {
  const h = read('public/login.html');
  const script = h.slice(h.lastIndexOf('<script>'));
  assert.doesNotMatch(script, /location\.href\s*=/);
  assert.doesNotMatch(script, /location\.assign\(/);
  assert.doesNotMatch(script, /history\.pushState/);
});
t('login.html: after sign-in, studio / HQ / onboarding is decided BEFORE leaving the page', () => {
  const h = read('public/login.html');
  const fn = /async function routeSignedIn\(\)\{([\s\S]*?)\n  \}/.exec(h);
  assert.ok(fn, 'routeSignedIn() exists');
  const body = fn[1];
  assert.match(body, /BPStore\.org\.resolveId\(\)/, 'strict studio lookup (an error is not "no studio")');
  assert.ok(body.indexOf('resolveId') < body.indexOf('operatorToHq'), 'HQ only asked after the studio check');
  assert.match(body, /if\(oid \|\| !known\)\{ location\.replace\(nextUrl\(\)\); return; \}/);
  assert.match(body, /if\(await BPStore\.auth\.operatorToHq\(\)\) return;/);
  assert.match(body, /showOnboarding\(\);/);
  // password sign-in and the already-signed-in (Google return) path both use it
  assert.ok((h.match(/await routeSignedIn\(\);/g) || []).length >= 2, 'both sign-in paths route through routeSignedIn');
  assert.doesNotMatch(h, /finishPendingStudio\(\); \}\n\s*location\.replace\(nextUrl\(\)\);/, 'old straight-to-dashboard path is gone');
});
t('login.html: a platform operator can never create a studio from onboarding / sign-up / pending name', () => {
  const h = read('public/login.html');
  const sub = h.slice(h.indexOf('$("#onboardForm").addEventListener("submit"'));
  assert.ok(sub.indexOf('operatorToHq()') > 0 && sub.indexOf('operatorToHq()') < sub.indexOf('createStudio('), 'onboarding submit: HQ check before createStudio');
  const pend = /async function finishPendingStudio\(\)\{([\s\S]*?)\n  \}/.exec(h)[1];
  assert.ok(pend.indexOf('isPlatformAdmin()') > 0 && pend.indexOf('isPlatformAdmin()') < pend.indexOf('createStudio('), 'pending studio: HQ check first');
  assert.ok(pend.indexOf('org.id()') < pend.indexOf('isPlatformAdmin()'), 'pending studio: HQ asked only with no studio');
});
t('operatorToHq(): replace → /hq only when is_platform_admin() is true', async () => {
  const yes = makeEnv({ path: '/login', gated: false, rpc: { is_platform_admin: { data: true, error: null } } });
  await yes.S.init();
  assert.equal(await yes.S.auth.operatorToHq(), true);
  assert.deepEqual(yes.replaced(), ['/hq']);
  const no = makeEnv({ path: '/login', gated: false, rpc: { is_platform_admin: { data: false, error: null } } });
  await no.S.init();
  assert.equal(await no.S.auth.operatorToHq(), false);
  const err = makeEnv({ path: '/login', gated: false, rpc: { is_platform_admin: { data: null, error: { message: 'x' } } } });
  await err.S.init();
  assert.equal(await err.S.auth.operatorToHq(), false);
  const out = makeEnv({ user: null, path: '/login', gated: false, rpc: { is_platform_admin: { data: true, error: null } } });
  await out.S.init();
  assert.equal(await out.S.auth.operatorToHq(), false, 'signed out: never asks');
  assert.ok(!out.rpcs().includes('is_platform_admin'));
  assert.deepEqual([...no.replaced(), ...err.replaced(), ...out.replaced()], []);
});
t('dashboard no longer paints then bounces: its own no-studio redirect is gone (gate decides first)', () => {
  const h = read('public/dashboard.html');
  assert.doesNotMatch(h, /if \(ok && !oid\) \{ location\.replace\("login\.html"\)/);
});
t('protected-page auth redirects use location.replace (builder / design sign-out included)', () => {
  const b = read('public/builder.js');
  assert.doesNotMatch(b, /signOut\(\); location\.href=/);
  assert.doesNotMatch(b, /!BPStore\.auth\.user\(\)\)\{\n\s*location\.href=/);
  assert.doesNotMatch(read('public/design.html'), /signOut\(\);location\.href=/);
  for (const p of PROTECTED) assert.doesNotMatch(read('public/' + p + '.html'), /location\.href\s*=\s*["'`]\/?login/, p);
});

/* ------------------------------------------------------------- run */
let pass = 0, fail = 0;
for (const [name, fn] of tests) {
  try { await fn(); pass++; console.log('ok - ' + name); }
  catch (e) { fail++; console.log('not ok - ' + name + ': ' + (e && e.message)); }
}
console.log(`\nauth-gate: ${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
