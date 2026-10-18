// session-resilience-1017.test.mjs — owner (Oct 2026): "session expired" appeared too often and
// opening helm.events flashed the landing page before the dashboard.
//  * a flaky / racing token refresh never signs the person out (only a definite refusal does)
//  * a token rotated by another tab is adopted instead of declaring the session dead
//  * a network failure in the sign-in status check shows "Couldn't reach Helm", not the sign-in page
//  * app-side idle / max-age limits stay OFF in config.js
//  * index.html forwards a signed-in visitor from <head> (before paint) straight to /dashboard
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const root = new URL('..', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
const SRC = read('public/store-api.js');
const tests = [];
const t = (name, fn) => tests.push([name, fn]);
const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };

function env(o = {}) {
  const calls = [];
  const user = { id: 'u-1', email: 'owner@a.test' };
  let session = { user, access_token: 'x', expires_at: Math.floor(Date.now() / 1000) + 3600 };
  let listener = null;
  const client = {
    auth: {
      async getSession() { calls.push(['getSession']); return { data: { session: o.getSession ? o.getSession(session, calls.filter((c) => c[0] === 'getSession').length) : session } }; },
      onAuthStateChange(fn) { listener = fn; return { data: { subscription: { unsubscribe() {} } } }; },
      async refreshSession() { calls.push(['refresh']); return o.refresh ? o.refresh(calls.filter((c) => c[0] === 'refresh').length) : { data: { session }, error: null }; },
      async signOut() { session = null; return { error: null }; },
      mfa: { async getAuthenticatorAssuranceLevel() { return { data: { currentLevel: 'aal1', nextLevel: 'aal1' }, error: null }; } },
    },
    async rpc(name) { calls.push(['rpc', name]); const r = (o.rpc || {})[name]; return typeof r === 'function' ? r() : (r || { data: name === 'current_org_id' ? 'org-1' : null, error: null }); },
    from() { const q = { select: () => q, eq: () => q, order: () => q, maybeSingle: async () => ({ data: { role: 'admin' }, error: null }), single: async () => ({ data: { role: 'admin' }, error: null }) }; return q; },
  };
  const cls = new Set(['auth-pending']);
  const loc = { pathname: '/dashboard', search: '', hash: '', origin: 'https://www.helm.events', href: '', hostname: 'www.helm.events',
    replace(u) { calls.push(['replace', u]); }, reload() { calls.push(['reload']); } };
  const el = () => ({ style: {}, setAttribute() {}, appendChild() {}, addEventListener() {}, querySelector: () => null, remove() {} });
  const body = { children: [], appendChild(c) { this.children.push(c); calls.push(['body.append']); }, removeChild() {}, get firstChild() { return null; }, insertBefore() {} };
  const doc = { readyState: 'complete', addEventListener() {}, removeEventListener() {}, currentScript: { src: 'https://www.helm.events/store-api.js?v=1' }, createElement: el, head: { appendChild() {} }, body,
    documentElement: { setAttribute() {}, getAttribute() { return 'light'; }, classList: { contains: (c) => cls.has(c), add: (c) => cls.add(c), remove: (c) => { cls.delete(c); calls.push(['reveal']); } } },
    querySelector: () => null, querySelectorAll: () => [], getElementById: () => null };
  const win = { SUPABASE_CONFIG: { url: 'https://abcdefghijklmnopqrst.supabase.co', anonKey: 'anon' }, supabase: { createClient: () => client },
    localStorage: mem(), sessionStorage: mem(), location: loc, document: doc, navigator: { onLine: true },
    fetch: async () => ({ ok: false, status: 503, json: async () => ({}) }), addEventListener() {}, removeEventListener() {},
    setTimeout: (fn) => { setImmediate(fn); return 0; }, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    atob: (b) => Buffer.from(b, 'base64').toString('binary'), console: { log() {}, info() {}, warn() {}, error() {} } };
  win.window = win; win.globalThis = win;
  vm.createContext(win); vm.runInContext(SRC, win, { filename: 'store-api.js' });
  return { S: win.BPStore, calls, fire: (ev, s) => listener && listener(ev, s), user, replaced: () => calls.filter((c) => c[0] === 'replace').map((c) => c[1]) };
}
const flush = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

t('flaky refresh (network / 5xx) after a spurious SIGNED_OUT never redirects to sign-in', async () => {
  const e = env({ refresh: () => ({ data: { session: null }, error: { name: 'AuthRetryableFetchError', message: 'Failed to fetch', status: 0 } }), getSession: (s, n) => (n === 1 ? s : null) });
  await e.S.init(); e.S.auth.required(); e.fire('SIGNED_OUT', null); await flush();
  assert.deepEqual(e.replaced(), []);
  assert.ok(e.calls.filter((c) => c[0] === 'refresh').length >= 2, 'retried');
});
t('a token rotated by another tab is adopted (no redirect)', async () => {
  const e = env({ refresh: () => ({ data: { session: null }, error: { code: 'refresh_token_already_used', status: 400, message: 'Invalid Refresh Token: Already Used' } }),
    getSession: (s) => s });
  await e.S.init(); e.S.auth.required(); e.fire('SIGNED_OUT', null); await flush();
  assert.deepEqual(e.replaced(), [], 'fresh session from storage wins');
});
t('a definitive refusal (revoked session, nothing in storage) still ends the session → login?expired=1', async () => {
  let gone = false;
  const e = env({ refresh: () => { gone = true; return { data: { session: null }, error: { code: 'session_not_found', status: 403, message: 'Session not found' } }; },
    getSession: (s) => (gone ? null : s) });
  await e.S.init(); e.S.auth.required(); e.fire('SIGNED_OUT', null); await flush();
  assert.equal(e.replaced().length, 1);
  assert.match(e.replaced()[0], /^login\.html\?next=dashboard&expired=1$/);
});
t('sign-in status check failing on the network → retried, then "Couldn\'t reach Helm" (never the sign-in page)', async () => {
  let n = 0;
  const e = env({ rpc: { password_change_required: () => { n++; return { data: null, error: { message: 'Failed to fetch' } }; } } });
  const p = e.S.init(); await flush();
  assert.equal(n, 3, 'three attempts');
  assert.deepEqual(e.replaced(), []);
  assert.ok(e.calls.some((c) => c[0] === 'body.append'), 'retry notice shown');
  void p;
});
t('a one-off status-check blip recovers silently and the page opens', async () => {
  let n = 0;
  const e = env({ rpc: { password_change_required: () => (++n === 1 ? { data: null, error: { message: 'Failed to fetch' } } : { data: false, error: null }) } });
  assert.equal(await e.S.init(), 'supabase');
  assert.deepEqual(e.replaced(), []);
  assert.ok(e.calls.some((c) => c[0] === 'reveal'));
});
t('config.js keeps app-side idle / max-age session limits OFF (owner: no timeout)', () => {
  const c = read('public/config.js');
  assert.match(c, /session:\s*\{\s*idleMinutes:\s*0\b[^}]*maxHours:\s*0\b/);
});
t('index.html forwards a signed-in visitor from <head> (no landing-page flash) to /dashboard (no extra 308 hop)', () => {
  const h = read('public/index.html');
  const head = h.slice(0, h.indexOf('</head>'));
  assert.match(head, /sb-\[a-z0-9\]\+-auth-token/);
  assert.match(head, /location\.replace\("\/dashboard"\)/);
  assert.doesNotMatch(h.slice(h.indexOf('</head>')), /auth-token/);
});

let pass = 0, fail = 0;
for (const [name, fn] of tests) {
  try { await fn(); pass++; console.log('ok - ' + name); }
  catch (e) { fail++; console.log('not ok - ' + name + ': ' + (e && e.message)); }
}
console.log(`\nsession-resilience-1017: ${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
