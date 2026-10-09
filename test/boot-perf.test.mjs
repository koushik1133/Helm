// boot-perf.test.mjs — page-load speed-ups must not loosen the auth gate.
//  * every page that loads store-api.js preconnects to the production Supabase origin
//    and preloads the pinned supabase-js build with the SAME integrity store-api uses
//  * a protected page asks for the studio id IN PARALLEL with the sign-in step check,
//    but still shows only after both answered (and never when a step is pending)
//  * role + access matrix are fetched during boot (not after the page shows)
//  * per-tab caches are stale-while-revalidate: a stale studio id shows the page and is
//    re-checked; a changed / revoked answer hides the page again
//  * config.js may be served stale while it revalidates; ?v= assets stay immutable
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const root = new URL('..', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
const SRC = read('public/store-api.js');
const tests = [];
const t = (name, fn) => tests.push([name, fn]);

/* ---------------------------------------------------------- 1. <head> hints */
const PROD = /url:\s*"(https:\/\/[a-z0-9]{20}\.supabase\.co)"/.exec(read('public/config.js'))[1];
const PAGES = readdirSync(new URL('public/', root)).filter((f) => f.endsWith('.html'));
const APP_PAGES = PAGES.filter((f) => /store-api\.js/.test(read('public/' + f)));
const SJS = /file:\s*"(vendor\/supabase-js-[0-9.]+\.min\.js)",\s*integrity:\s*"(sha384-[A-Za-z0-9+/=]+)"/.exec(SRC);

t('the pinned supabase-js integrity in store-api.js matches the vendored file', () => {
  assert.ok(SJS, 'SUPABASE_JS {file, integrity} not found');
  const sri = 'sha384-' + createHash('sha384').update(readFileSync(new URL('public/' + SJS[1], root))).digest('base64');
  assert.equal(SJS[2], sri);
});
t('every page that loads store-api.js preconnects to the production Supabase origin (+ dns-prefetch) in <head>', () => {
  assert.ok(APP_PAGES.length >= 40, 'found ' + APP_PAGES.length);
  for (const f of APP_PAGES) {
    const h = read('public/' + f); const head = h.slice(0, h.indexOf('</head>'));
    assert.ok(head.includes(`<link rel="preconnect" href="${PROD}" crossorigin>`), f + ': preconnect');
    assert.ok(head.includes(`<link rel="dns-prefetch" href="${PROD}">`), f + ': dns-prefetch');
  }
});
t('every page that loads store-api.js preloads supabase-js with the same URL + integrity + CORS mode', () => {
  for (const f of APP_PAGES) {
    const h = read('public/' + f); const head = h.slice(0, h.indexOf('</head>'));
    const tag = `<link rel="preload" href="/${SJS[1]}" as="script" integrity="${SJS[2]}" crossorigin="anonymous">`;
    assert.ok(head.includes(tag), f + ': preload tag missing or out of date (must equal store-api SUPABASE_JS)');
  }
});
t('the preconnected origin is allowed by the CSP connect-src (no new origin introduced)', () => {
  const v = JSON.parse(read('vercel.json'));
  const csp = v.headers.find((h) => h.source === '/(.*)').headers.find((x) => x.key === 'Content-Security-Policy').value;
  const cs = /connect-src ([^;]+)/.exec(csp)[1].split(/\s+/);
  assert.ok(cs.includes(PROD));
});
t('marketing pages without store-api.js get no Supabase hints', () => {
  for (const f of ['index.html', 'about.html', 'services.html', 'privacy.html', 'terms.html']) {
    if (!PAGES.includes(f)) continue;
    assert.doesNotMatch(read('public/' + f), /supabase\.co/, f);
  }
});
t('cache policy: config.js may be served stale while revalidating; versioned + vendor assets stay immutable', () => {
  const v = JSON.parse(read('vercel.json'));
  const hdr = (path, key) => { let out; for (const h of v.headers) if (!h.has && new RegExp('^' + h.source + '$').test(path)) for (const x of h.headers) if (x.key === key) out = x.value; return out; };
  assert.equal(hdr('/config.js', 'Cache-Control'), 'public, max-age=300, stale-while-revalidate=3600');
  assert.equal(hdr('/store-api.js', 'Cache-Control'), 'public, max-age=31536000, immutable');
  assert.equal(hdr('/' + SJS[1], 'Cache-Control'), 'public, max-age=31536000, immutable');
  assert.equal(hdr('/dashboard', 'Cache-Control'), 'no-store');
});

/* --------------------------------------------------------- 2. boot sandbox */
function memStore(init) {
  const m = new Map(Object.entries(init || {}));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _m: m };
}
function makeEnv(o = {}) {
  const calls = [];
  const user = { id: 'u-1', email: 'staff@a.test' };
  const session = { user, access_token: 'x' };
  const cls = new Set(['auth-pending']);
  const client = {
    auth: {
      async getSession() { return { data: { session } }; },
      onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; },
      async refreshSession() { return { data: { session }, error: null }; },
      async signOut() { return { error: null }; },
      mfa: { async getAuthenticatorAssuranceLevel() { return { data: { currentLevel: 'aal1', nextLevel: 'aal1' }, error: null }; } },
    },
    rpc(name, args) {
      calls.push(['rpc', name]);
      const r = (o.rpc || {})[name];
      if (typeof r === 'function') return r(args);
      return Promise.resolve(r || { data: null, error: null });
    },
    from(table) {
      const q = { select: () => q, eq: () => q, order: () => q,
        single: async () => { calls.push(['from', table]); return { data: { role: o.role || 'sales' }, error: null }; },
        maybeSingle: async () => { calls.push(['from', table]); return { data: { role: o.role || 'sales' }, error: null }; },
        then: (res, rej) => { calls.push(['from', table]); return Promise.resolve({ data: [{ area: 'leads', can_view: true, can_edit: false }], error: null }).then(res, rej); } };
      return q;
    },
  };
  const loc = { pathname: o.path || '/dashboard', search: '', hash: '', origin: 'https://www.helm.events', href: '', hostname: 'www.helm.events',
    replace(u) { calls.push(['location.replace', u]); }, reload() { calls.push(['location.reload']); } };
  const heads = [];
  const el = (tag) => ({ tag, style: {}, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, appendChild() {}, addEventListener() {}, querySelector: () => null, remove() {} });
  const doc = {
    readyState: 'complete', addEventListener() {}, removeEventListener() {}, currentScript: { src: 'https://www.helm.events/store-api.js?v=1' },
    createElement: el, head: { appendChild(n) { heads.push(n); } }, body: { children: [], appendChild(c) { this.children.push(c); }, removeChild() {}, get firstChild() { return null; } },
    documentElement: { setAttribute() {}, getAttribute() { return 'light'; },
      classList: { contains: (c) => cls.has(c), add: (c) => { cls.add(c); calls.push(['hide']); }, remove: (c) => { cls.delete(c); calls.push(['reveal']); } } },
    querySelector: () => null, querySelectorAll: () => [], getElementById: () => null,
  };
  const win = {
    SUPABASE_CONFIG: { url: o.url || 'https://abcdefghijklmnopqrst.supabase.co', anonKey: 'anon' },
    supabase: { createClient: () => client },
    localStorage: memStore(), sessionStorage: memStore(o.ss), location: loc, document: doc, navigator: { onLine: true },
    fetch: async () => ({ ok: false, status: 503, json: async () => ({}) }),
    addEventListener() {}, removeEventListener() {},
    setTimeout: (fn, ms) => { if (!ms || ms < 1000) { try { fn(); } catch (e) {} } return 0; }, clearTimeout() {},
    setInterval: () => 0, clearInterval() {},
    atob: (b) => Buffer.from(b, 'base64').toString('binary'),
    console: { log() {}, info() {}, warn() {}, error() {} },
  };
  win.window = win; win.globalThis = win;
  vm.createContext(win);
  vm.runInContext(SRC, win, { filename: 'store-api.js' });
  return { win, S: win.BPStore, calls, heads, gated: () => cls.has('auth-pending'),
    replaced: () => calls.filter((c) => c[0] === 'location.replace').map((c) => c[1]),
    idx: (kind, name) => calls.findIndex((c) => c[0] === kind && c[1] === name) };
}
const flush = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const deferred = () => { let res; const p = new Promise((r) => { res = r; }); return { p, res }; };
const entry = (uid, val, ageMs) => JSON.stringify({ ts: Date.now() - ageMs, uid, val });

t('store-api preconnects to the CONFIGURED Supabase origin (staging / local) at load', () => {
  const e = makeEnv({ url: 'https://xizehqgeyjcfpzrdymly.supabase.co' });
  const l = e.heads.find((n) => n.attrs.rel === 'preconnect');
  assert.ok(l, 'no preconnect injected');
  assert.equal(l.attrs.href, 'https://xizehqgeyjcfpzrdymly.supabase.co');
  assert.equal(l.attrs.crossorigin, 'anonymous');
});
t('protected page: studio lookup runs WHILE the temp-password check is in flight; page shows only after both', async () => {
  const pw = deferred();
  const e = makeEnv({ rpc: { password_change_required: () => pw.p, current_org_id: { data: 'org-1', error: null } } });
  const init = e.S.init();
  await flush();
  assert.ok(e.idx('rpc', 'current_org_id') >= 0, 'studio lookup must already be in flight');
  assert.ok(e.idx('rpc', 'password_change_required') >= 0);
  assert.equal(e.gated(), true, 'still hidden while the sign-in step check is pending');
  pw.res({ data: false, error: null });
  assert.equal(await init, 'supabase');
  assert.equal(e.gated(), false);
});
t('a pending temp-password step still sends the person to sign-in even though the studio answered', async () => {
  const e = makeEnv({ rpc: { password_change_required: { data: true, error: null }, current_org_id: { data: 'org-1', error: null } } });
  e.S.init(); await flush();
  assert.equal(e.gated(), true);
  assert.deepEqual(e.replaced(), ['/login?next=dashboard']);
});
t('role + access matrix are requested during boot, before page code asks', async () => {
  const e = makeEnv({ rpc: { current_org_id: { data: 'org-1', error: null } } });
  await e.S.init(); await flush();
  assert.ok(e.idx('from', 'profiles') >= 0, 'profiles fetched at boot');
  assert.ok(e.idx('from', 'role_access') >= 0, 'role_access fetched at boot');
  const n = e.calls.length;
  assert.equal(await e.S.auth.role(), 'sales');
  assert.equal(await e.S.auth.canView('leads'), true);
  assert.equal(e.calls.length, n, 'page reads come from the boot prefetch (no extra round-trips)');
});
t('fresh cached studio id (< 60 s): page shows with no studio round-trip', async () => {
  const e = makeEnv({ ss: { bp_sess_org: entry('u-1', 'org-1', 10000), bp_pw_ok: 'u-1' } });
  await e.S.init();
  assert.equal(e.gated(), false);
  assert.equal(e.idx('rpc', 'current_org_id'), -1);
});
t('stale cached studio id (5 min): page shows now, re-checked in the background, cache refreshed', async () => {
  const e = makeEnv({ ss: { bp_sess_org: entry('u-1', 'org-1', 5 * 60000), bp_pw_ok: 'u-1' }, rpc: { current_org_id: { data: 'org-1', error: null } } });
  await e.S.init(); await flush();
  assert.equal(e.gated(), false);
  assert.ok(e.idx('rpc', 'current_org_id') >= 0, 'background re-check ran');
  const o = JSON.parse(e.win.sessionStorage.getItem('bp_sess_org'));
  assert.ok(Date.now() - o.ts < 5000, 'timestamp refreshed');
  assert.deepEqual(e.replaced(), []);
});
t('stale studio id that CHANGED on the server: page hidden again + reload (gate decides afresh)', async () => {
  const e = makeEnv({ ss: { bp_sess_org: entry('u-1', 'org-1', 5 * 60000), bp_pw_ok: 'u-1' }, rpc: { current_org_id: { data: null, error: null } } });
  e.S.init(); await flush();
  assert.equal(e.gated(), true);
  assert.ok(e.calls.some((c) => c[0] === 'location.reload'));
  assert.equal(e.win.sessionStorage.getItem('bp_sess_org'), null);
});
t('stale studio id whose re-check is REJECTED (token): page hidden + sign-in', async () => {
  const e = makeEnv({ ss: { bp_sess_org: entry('u-1', 'org-1', 5 * 60000), bp_pw_ok: 'u-1' }, rpc: { current_org_id: { data: null, error: { code: 'PGRST301', message: 'JWT expired' } } } });
  e.S.init(); await flush();
  assert.equal(e.gated(), true);
  assert.ok(e.replaced().includes('/login?next=dashboard'));
});
t('stale studio id + network blip on re-check: page stays (RLS still guards every read)', async () => {
  const e = makeEnv({ ss: { bp_sess_org: entry('u-1', 'org-1', 5 * 60000), bp_pw_ok: 'u-1' }, rpc: { current_org_id: { data: null, error: { message: 'Failed to fetch' } } } });
  await e.S.init(); await flush();
  assert.equal(e.gated(), false);
  assert.deepEqual(e.replaced(), []);
});
t('cache older than 10 min is ignored: the page waits for a real studio answer', async () => {
  const d = deferred();
  const e = makeEnv({ ss: { bp_sess_org: entry('u-1', 'org-1', 11 * 60000), bp_pw_ok: 'u-1' }, rpc: { current_org_id: () => d.p } });
  const init = e.S.init(); await flush();
  assert.equal(e.gated(), true, 'hidden until the server answers');
  d.res({ data: 'org-1', error: null });
  await init;
  assert.equal(e.gated(), false);
});
t("another user's cached entries are never used (stale or fresh)", async () => {
  const e = makeEnv({ ss: { bp_sess_org: entry('u-2', 'org-9', 1000), bp_sess_role: entry('u-2', 'admin', 1000) }, rpc: { current_org_id: { data: 'org-1', error: null } } });
  await e.S.init(); await flush();
  assert.ok(e.idx('rpc', 'current_org_id') >= 0);
  assert.equal(await e.S.auth.role(), 'sales');
});
t('stale role / matrix: used for this page, refreshed in the background for the next one', async () => {
  const e = makeEnv({ role: 'planner', ss: { bp_sess_org: entry('u-1', 'org-1', 1000), bp_pw_ok: 'u-1',
    bp_sess_role: entry('u-1', 'sales', 5 * 60000), bp_sess_access: entry('u-1', { role: 'sales', map: { leads: { view: true, edit: true } } }, 5 * 60000) } });
  await e.S.init(); await flush();
  assert.equal(await e.S.auth.role(), 'sales', 'this page keeps its stale role');
  const r = JSON.parse(e.win.sessionStorage.getItem('bp_sess_role'));
  const a = JSON.parse(e.win.sessionStorage.getItem('bp_sess_access'));
  assert.equal(r.val, 'planner', 'next navigation sees the new role');
  assert.equal(a.val.role, 'planner', 'role and matrix are refreshed together');
});

let pass = 0, fail = 0;
for (const [name, fn] of tests) {
  try { await fn(); pass++; console.log('ok - ' + name); }
  catch (e) { fail++; console.log('not ok - ' + name + ': ' + (e && e.message)); }
}
console.log(`\nboot-perf: ${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
