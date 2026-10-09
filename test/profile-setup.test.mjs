// "Complete your profile" (0041) — front end. public/store-api.js runs in a vm sandbox
// with a stub Supabase client (no network, no real credentials):
//  * gate routing: a NEW member who must complete → /profile-setup?next=… before any app
//    page shows (never flashes); an OLDER incomplete member → banner only; HQ operator /
//    client → never; 0041 not installed → nothing changes; /profile-setup never loops
//  * BPStore.profile.validate mirrors the SQL rules (Indian mobile, text <= 80 without < >,
//    skills <= 20 x 40), and update / complete never send an invalid payload
//  * profile photo guards: magic bytes, size limits, centre-square crop at <= 512 px,
//    own-folder storage key, then set_my_avatar
//  * ?next= on /profile-setup goes through the shared same-site sanitiser
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const root = new URL('..', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
const SRC = read('public/store-api.js');
const tests = [];
const t = (name, fn) => tests.push([name, fn]);

const ORG_ID = '11111111-2222-4333-8444-555555555555';
const UID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const st = (complete, required, nudge) => ({ data: { complete, required, nudge }, error: null });
const MISSING = { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.my_profile_status without parameters in the schema cache' } };
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52];
const JPG = [0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1];
const WEBP = [0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20];
const GIF = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0];
const SVG = Array.from(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'));
const blob = (bytes, type, pad = 0) => new Blob([new Uint8Array(bytes), new Uint8Array(pad)], type ? { type } : {});

/* ------------------------------------------------------------ sandbox */
function memStore(init) {
  const m = new Map(Object.entries(init || {}));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _m: m };
}
function makeEnv(o = {}) {
  const calls = [];
  const user = o.user === null ? null : (o.user || { id: UID, email: 'new@studio.test' });
  const session = user ? { user, access_token: 'x' } : null;
  const cls = new Set(o.gated === false ? [] : ['auth-pending']);
  const rpcs = Object.assign({ current_org_id: { data: ORG_ID, error: null } }, o.rpc || {});
  const storage = {
    from(bucket) {
      return {
        async upload(path, body, opts) { calls.push(['upload', bucket, path, body, opts]); return o.uploadError ? { data: null, error: o.uploadError } : { data: { path }, error: null }; },
        async createSignedUrls(paths, ttl) { calls.push(['sign', bucket, paths.slice(), ttl]); return { data: paths.map((p) => ({ path: p, signedUrl: 'https://abcdefghijklmnopqrst.supabase.co/storage/v1/object/sign/' + bucket + '/' + p + '?token=t', error: null })), error: null }; },
      };
    },
  };
  const client = {
    auth: {
      async getSession() { return { data: { session } }; },
      onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; },
      async refreshSession() { return { data: { session }, error: session ? null : { message: 'no' } }; },
      async signOut() { return { error: null }; },
      mfa: { async getAuthenticatorAssuranceLevel() { return { data: { currentLevel: 'aal1', nextLevel: 'aal1' }, error: null }; } },
    },
    async rpc(name, args) {
      calls.push(['rpc', name, args]);
      const r = rpcs[name];
      if (typeof r === 'function') return r(args);
      if (r) return r;
      return { data: null, error: null };
    },
    from(table) {
      const q = { select: (c) => { q._cols = c; return q; }, eq: () => q, order: () => q,
        single: async () => ({ data: { role: o.role || 'planner' }, error: null }),
        maybeSingle: async () => { if (q._cols === 'role') return { data: { role: o.role || 'planner' }, error: null };   // getRole (L7: maybeSingle)
          calls.push(['from', table]); return { data: { id: UID, email: 'new@studio.test', full_name: 'Old Name', role: 'planner' }, error: null }; } };
      return q;
    },
    storage,
  };
  const loc = { pathname: o.path || '/dashboard', search: o.search || '', hash: '', origin: 'https://www.helm.events', href: '', hostname: 'www.helm.events',
    replace(u) { calls.push(['location.replace', u]); }, reload() { calls.push(['location.reload']); } };
  const body = { children: [], appendChild(c) { this.children.push(c); }, removeChild(c) { this.children = this.children.filter((x) => x !== c); }, get firstChild() { return this.children[0] || null; }, insertBefore() {} };
  const canvas = o.canvas || null;
  const el = (tag) => (tag === 'canvas' && canvas) ? canvas() : ({ tag, style: {}, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, appendChild() {}, addEventListener() {}, querySelector: () => null, remove() {}, set src(v) {}, get src() { return ''; } });
  const doc = {
    readyState: 'complete', addEventListener() {}, removeEventListener() {}, currentScript: { src: 'https://www.helm.events/store-api.js?v=1' },
    createElement: el, head: { appendChild() {} }, body,
    documentElement: { setAttribute() {}, getAttribute() { return 'light'; },
      classList: { contains: (c) => cls.has(c), add: (c) => { cls.add(c); calls.push(['hide']); }, remove: (c) => { cls.delete(c); calls.push(['reveal']); } } },
    querySelector: () => null, querySelectorAll: () => [], getElementById: () => null,
  };
  const win = {
    SUPABASE_CONFIG: { url: 'https://abcdefghijklmnopqrst.supabase.co', anonKey: 'anon' },
    supabase: { createClient: () => client },
    localStorage: memStore(o.ls), sessionStorage: memStore(o.ss),
    location: loc, document: doc, navigator: { onLine: true },
    fetch: async () => ({ ok: false, status: 503, json: async () => ({}) }),
    addEventListener() {}, removeEventListener() {},
    setTimeout: (fn, ms) => { if (!ms || ms < 1000) { try { fn(); } catch (e) {} } return 0; }, clearTimeout() {},
    setInterval: () => 0, clearInterval() {},
    atob: (b) => Buffer.from(b, 'base64').toString('binary'),
    crypto: globalThis.crypto, Blob, Response, Uint8Array, ArrayBuffer,
    createImageBitmap: o.bitmap ? async () => o.bitmap : undefined,
    console: { log() {}, info() {}, warn() {}, error() {} }, Date, Promise, URLSearchParams, URL, JSON, Math, Object, Array, String, Number, RegExp, Error, Map, Set,
  };
  win.window = win; win.globalThis = win;
  vm.createContext(win);
  vm.runInContext(SRC, win, { filename: 'store-api.js' });
  return {
    win, S: win.BPStore, calls, gated: () => cls.has('auth-pending'),
    replaced: () => calls.filter((c) => c[0] === 'location.replace').map((c) => c[1]),
    rpcCalls: (n) => calls.filter((c) => c[0] === 'rpc' && c[1] === n),
  };
}
const flush = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const settles = async (p) => { let done = false; p.then(() => { done = true; }, () => { done = true; }); await flush(); return done; };
// Values made inside the vm carry its own Object/Array prototypes; compare plain copies.
const plain = (v) => JSON.parse(JSON.stringify(v));

/* ------------------------------------------------------- 1. gate routing */
t('NEW member who must complete: hidden → replace /profile-setup?next=<page> before the page shows', async () => {
  const e = makeEnv({ path: '/quotes', search: '?q=1', rpc: { my_profile_status: st(false, true, false) } });
  assert.equal(await settles(e.S.init()), false, 'page code never runs');
  assert.deepEqual(e.replaced(), ['/profile-setup?next=' + encodeURIComponent('quotes.html?q=1')]);
  assert.equal(e.gated(), true, 'body never revealed (no flash)');
  assert.ok(!e.calls.some((c) => c[0] === 'reveal'));
  assert.equal(e.rpcCalls('my_profile_status').length, 1, 'asked once, alongside the studio lookup');
});
t('a "must complete" answer is never cached (asked again on the next page)', async () => {
  const e = makeEnv({ path: '/dashboard', rpc: { my_profile_status: st(false, true, false) } });
  await settles(e.S.init());
  assert.equal(e.win.sessionStorage.getItem('bp_sess_profile'), null);
});
t('OLDER incomplete member (joined before the cutoff): page shows, banner decision = nudge', async () => {
  const e = makeEnv({ path: '/dashboard', rpc: { my_profile_status: st(false, false, true) } });
  assert.equal(await e.S.init(), 'supabase');
  assert.deepEqual(e.replaced(), []);
  assert.equal(e.gated(), false);
  const s = await e.S.profile.status();
  assert.equal(e.S.profile.gateDecision(s, 'dashboard', null), 'nudge');
  assert.equal(e.rpcCalls('my_profile_status').length, 1, 'banner reuses the cached answer');
});
t('banner snooze: 7 days, per account, localStorage errors never break it', async () => {
  const e = makeEnv({ path: '/dashboard', rpc: { my_profile_status: st(false, false, true) } });
  await e.S.init();
  assert.equal(e.S.profile.nudgeSnoozed(), false);
  e.S.profile.snoozeNudge(7);
  assert.equal(e.S.profile.nudgeSnoozed(), true);
  const saved = JSON.parse(e.win.localStorage.getItem('helm_profile_nudge'));
  assert.equal(saved.uid, UID);
  assert.ok(saved.until - Date.now() > 6.9 * 86400000 && saved.until - Date.now() <= 7 * 86400000);
  // another account on this browser is not snoozed; an expired snooze shows again
  const other = makeEnv({ path: '/dashboard', user: { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', email: 'b@x.test' }, ls: { helm_profile_nudge: JSON.stringify(saved) }, rpc: { my_profile_status: st(false, false, true) } });
  await other.S.init();
  assert.equal(other.S.profile.nudgeSnoozed(), false);
  const old = makeEnv({ path: '/dashboard', ls: { helm_profile_nudge: JSON.stringify({ uid: UID, until: Date.now() - 1 }) }, rpc: { my_profile_status: st(false, false, true) } });
  await old.S.init();
  assert.equal(old.S.profile.nudgeSnoozed(), false);
  const broken = makeEnv({ path: '/dashboard', rpc: { my_profile_status: st(false, false, true) } });
  await broken.S.init();
  broken.win.localStorage.getItem = () => { throw new Error('blocked'); };
  broken.win.localStorage.setItem = () => { throw new Error('blocked'); };
  assert.equal(broken.S.profile.nudgeSnoozed(), false);
  broken.S.profile.snoozeNudge(7);   // must not throw
});
t('HQ operator (server: required=false, nudge=false): never redirected, never nudged', async () => {
  const e = makeEnv({ path: '/dashboard', user: { id: UID, email: 'ops@helm.events' }, rpc: { my_profile_status: st(false, false, false) } });
  assert.equal(await e.S.init(), 'supabase');
  assert.deepEqual(e.replaced(), []);
  assert.equal(e.S.profile.gateDecision(await e.S.profile.status(), 'dashboard', null), 'none');
});
t('client accounts: never (server says no; the UI also refuses for a client role)', async () => {
  const e = makeEnv({ path: '/dashboard', role: 'client', rpc: { my_profile_status: st(false, false, false) } });
  await e.S.init();
  assert.deepEqual(e.replaced(), []);
  const G = e.S.profile.gateDecision;
  assert.equal(G({ complete: false, required: true, nudge: false }, 'dashboard', 'client'), 'none');
  assert.equal(G({ complete: false, required: false, nudge: true }, 'dashboard', 'client'), 'none');
  assert.equal(G({ complete: false, required: true, nudge: false }, 'dashboard', 'planner'), 'setup');
  assert.equal(G({ complete: true, required: true, nudge: true }, 'dashboard', 'planner'), 'none');
  assert.equal(G(null, 'dashboard', 'planner'), 'none');
  assert.equal(G({ missing: true }, 'dashboard', 'planner'), 'none');
  assert.equal(G({ complete: false, required: true }, 'profile-setup', 'planner'), 'none', 'never sends /profile-setup to itself');
});
t('0041 not installed (PGRST202): nothing changes — page shows, feature off, legacy mine()', async () => {
  const e = makeEnv({ path: '/dashboard', rpc: { my_profile_status: MISSING, my_profile: { data: null, error: { code: '42883', message: 'function public.my_profile() does not exist' } } } });
  assert.equal(await e.S.init(), 'supabase');
  assert.deepEqual(e.replaced(), []);
  assert.equal(e.gated(), false);
  assert.deepEqual(plain(await e.S.profile.status()), { missing: true });
  assert.equal(await e.S.profile.available(), false);
  const me = await e.S.profile.mine();
  assert.equal(me.full_name, 'Old Name', 'falls back to the profiles row');
  assert.ok(!('complete' in me), 'no profile fields → Account panel keeps the display-name section');
  await e.S.profile.mine();
  assert.equal(e.rpcCalls('my_profile').length, 1, 'missing RPC is not asked again on this page');
  assert.ok(JSON.parse(e.win.sessionStorage.getItem('bp_sess_profile')).val.missing, '"missing" cached for the tab (no log noise)');
});
t('status lookup failing (network): fail OPEN — page shows, nothing cached', async () => {
  const e = makeEnv({ path: '/dashboard', rpc: { my_profile_status: { data: null, error: { message: 'Failed to fetch' } } } });
  assert.equal(await e.S.init(), 'supabase');
  assert.deepEqual(e.replaced(), []);
  assert.equal(e.gated(), false);
  assert.equal(e.win.sessionStorage.getItem('bp_sess_profile'), null);
  assert.equal(await e.S.profile.status(), null, 'status() never throws');
});
t('status lookup rejected as an expired token: hidden → login', async () => {
  const e = makeEnv({ path: '/quotes', rpc: { my_profile_status: { data: null, error: { code: 'PGRST301', message: 'JWT expired' } } } });
  assert.equal(await settles(e.S.init()), false);
  assert.ok(e.replaced().includes('/login?next=quotes'));
  assert.equal(e.gated(), true);
});
t('public pages and the login page never ask for the profile status during boot', async () => {
  for (const path of ['/', '/login', '/approve', '/portal', '/work']) {
    const e = makeEnv({ path, gated: false, rpc: { my_profile_status: st(false, true, false) } });
    await e.S.init();
    assert.deepEqual(e.replaced(), [], path);
    assert.equal(e.rpcCalls('my_profile_status').length, 0, path);
  }
});
t('/profile-setup: shown while incomplete (required or nudge); never redirects to itself', async () => {
  for (const ans of [st(false, true, false), st(false, false, true)]) {
    const e = makeEnv({ path: '/profile-setup', search: '?next=quotes.html', rpc: { my_profile_status: ans } });
    assert.equal(await e.S.init(), 'supabase');
    assert.deepEqual(e.replaced(), []);
    assert.equal(e.gated(), false);
  }
});
t('/profile-setup with nothing to do (complete / client / operator / 0041 missing): hidden → replace ?next=', async () => {
  for (const ans of [st(true, false, false), st(false, false, false), MISSING]) {
    const e = makeEnv({ path: '/profile-setup', search: '?next=' + encodeURIComponent('flow.html?quote=abc'), rpc: { my_profile_status: ans } });
    assert.equal(await settles(e.S.init()), false);
    assert.deepEqual(e.replaced(), ['flow.html?quote=abc']);
    assert.equal(e.gated(), true, 'never flashes the form');
  }
});
t('/profile-setup ?next= is same-site only (shared sanitiser) — never itself, never off-site', async () => {
  const cases = { '?next=quotes.html%3Fq%3D1': 'quotes.html?q=1', '?next=chat': 'chat.html', '': 'dashboard.html',
    '?next=%2F%2Fevil.com': 'dashboard.html', '?next=https%3A%2F%2Fevil.com': 'dashboard.html', '?next=javascript%3Aalert(1)': 'dashboard.html',
    '?next=profile-setup': 'dashboard.html', '?next=profile-setup.html%3Fnext%3Dquotes': 'dashboard.html', '?next=login': 'dashboard.html', '?next=hq': 'dashboard.html' };
  for (const [search, want] of Object.entries(cases)) {
    const e = makeEnv({ path: '/profile-setup', search, rpc: { my_profile_status: st(false, true, false) } });
    await e.S.init();
    assert.equal(e.S.profile.setupNext(), want, search);
    const done = makeEnv({ path: '/profile-setup', search, rpc: { my_profile_status: st(true, false, false) } });
    await settles(done.S.init());
    assert.deepEqual(done.replaced(), [want], search);
  }
});
t('after saving: "complete" is remembered for the tab — the next page shows without asking again', async () => {
  const row = { user_id: UID, full_name: 'Ananya Rao', phone: '+919876543210', complete: true, skills: [] };
  const e = makeEnv({ path: '/profile-setup', search: '?next=dashboard', rpc: { my_profile_status: st(false, true, false), complete_my_profile: { data: row, error: null } } });
  await e.S.init();
  await e.S.profile.complete({ full_name: 'Ananya Rao', phone: '98765 43210' });
  const cached = JSON.parse(e.win.sessionStorage.getItem('bp_sess_profile'));
  assert.equal(cached.uid, UID);
  assert.equal(cached.val.complete, true);
  const next = makeEnv({ path: '/dashboard', ss: { bp_sess_profile: e.win.sessionStorage.getItem('bp_sess_profile') }, rpc: { my_profile_status: st(false, true, false) } });
  assert.equal(await next.S.init(), 'supabase');
  assert.deepEqual(next.replaced(), []);
  assert.equal(next.rpcCalls('my_profile_status').length, 0);
});
t('login: a new member is routed to /profile-setup?next=… straight from sign-in (routeIfRequired)', async () => {
  const e = makeEnv({ path: '/login', gated: false, rpc: { my_profile_status: st(false, true, false) } });
  await e.S.init();
  assert.equal(await e.S.profile.routeIfRequired('quotes.html'), true);
  assert.deepEqual(e.replaced(), ['/profile-setup?next=quotes.html']);
  for (const ans of [st(true, false, false), st(false, false, true), st(false, false, false), MISSING, { data: null, error: { message: 'Failed to fetch' } }]) {
    const n = makeEnv({ path: '/login', gated: false, rpc: { my_profile_status: ans } });
    await n.S.init();
    assert.equal(await n.S.profile.routeIfRequired('quotes.html'), false);
    assert.deepEqual(n.replaced(), []);
  }
  const out = makeEnv({ user: null, path: '/login', gated: false, rpc: { my_profile_status: st(false, true, false) } });
  await out.S.init();
  assert.equal(await out.S.profile.routeIfRequired('dashboard.html'), false, 'signed out: never asks');
  assert.equal(out.rpcCalls('my_profile_status').length, 0);
});
t('login.html: profile step is checked after the studio lookup, before leaving for ?next=', () => {
  const h = read('public/login.html');
  const fn = /async function routeSignedIn\(\)\{([\s\S]*?)\n  \}/.exec(h)[1];
  const a = fn.indexOf('resolveId()'), b = fn.indexOf('routeIfRequired(nextUrl())'), c = fn.indexOf('if(oid || !known){ location.replace(nextUrl()); return; }');
  assert.ok(a >= 0 && b > a && c > b, 'resolveId → routeIfRequired → next');
  assert.match(fn, /if\(oid && BPStore\.profile\.routeIfRequired && await BPStore\.profile\.routeIfRequired\(nextUrl\(\)\)\) return;/);
});

/* ----------------------------------------------------- 2. validation */
const V = makeEnv({ user: null, path: '/login', gated: false }).S.profile.validate;
t('mobile: Indian 10-digit numbers starting 6-9 (+91XXXXXXXXXX); international E.164 with a leading + (0055)', () => {
  for (const ok of ['9876543210', '98765 43210', '+91 98765 43210', '+91-98765-43210', '919876543210', '09876543210', '(98765) 43210', '6000000000'])
    assert.equal(V({ phone: ok }).clean.phone, '+919876543210'.replace('9876543210', ok.replace(/\D/g, '').slice(-10)), ok);
  for (const bad of ['5876543210', '12345', '98765abc10', '987654321', '98765432101', '+1 202', '+44 12', '0000000000', '+91 5876543210', '+1234567890123456'])
    assert.ok(V({ phone: bad }).errors.phone, bad);
  assert.equal(V({ phone: '+1 202 555 0123' }).clean.phone, '+12025550123');
  assert.equal(V({ phone: '+44 7911 123456' }).clean.phone, '+447911123456');
  assert.match(V({ phone: '5876543210' }).errors.phone, /starting with 6, 7, 8 or 9/);
  assert.equal(V({ phone: '' }, { requirePhone: true }).errors.phone, 'Mobile number is required.');
  assert.ok(!('phone' in V({ phone: '  ' }).clean), 'a blank optional mobile is left out (it can never be cleared)');
});
t('WhatsApp: "same as mobile" sends no number; otherwise an Indian mobile', () => {
  const same = V({ phone: '9876543210', whatsapp_same: true, whatsapp: 'junk' });
  assert.equal(same.ok, true);
  assert.equal(same.clean.whatsapp_same, true);
  assert.ok(!('whatsapp' in same.clean));
  assert.equal(V({ whatsapp_same: false, whatsapp: '8765432109' }).clean.whatsapp, '+918765432109');
  assert.match(V({ whatsapp_same: false, whatsapp: '1234' }).errors.whatsapp, /^WhatsApp number must be/);
  assert.equal(V({ whatsapp_same: false, whatsapp: '' }).clean.whatsapp, null);
});
t('text fields: trimmed, spaces collapsed, <= 80 characters, no < > or control characters, blank → null', () => {
  assert.equal(V({ full_name: '  Ananya   Rao ' }).clean.full_name, 'Ananya Rao');
  assert.equal(V({ full_name: 'x'.repeat(80) }).ok, true);
  assert.equal(V({ full_name: 'x'.repeat(81) }).errors.full_name, 'Full name must be 80 characters or fewer.');
  assert.equal(V({ job_title: '<b>Boss</b>' }).errors.job_title, "Job title can't contain < or >.");
  assert.equal(V({ city: 'Hyd\u0007' }).errors.city, "City can't contain control characters.");
  assert.equal(V({ department: 'a>b' }).errors.department, "Department can't contain < or >.");
  assert.equal(V({ emergency_contact_name: 'é'.repeat(80) }).ok, true, 'counts characters, not bytes');
  assert.equal(V({ department: '   ' }).clean.department, null, 'blank clears');
  assert.equal(V({ full_name: '' }, { requireName: true }).errors.full_name, 'Full name is required.');
  assert.ok(!('full_name' in V({ full_name: '' }).clean));
});
t('emergency contact number: an Indian mobile, or an international number with +', () => {
  assert.equal(V({ emergency_contact_phone: '98765 43210' }).clean.emergency_contact_phone, '+919876543210');
  assert.equal(V({ emergency_contact_phone: '+44 20 7946 0958' }).clean.emergency_contact_phone, '+442079460958');
  for (const bad of ['12345', '2079460958', '+0 123 456 789', 'call me', '+1234'])
    assert.ok(V({ emergency_contact_phone: bad }).errors.emergency_contact_phone, bad);
  assert.equal(V({ emergency_contact_phone: '' }).clean.emergency_contact_phone, null);
});
t('skills: up to 20 tags of <= 40 characters, deduped (case-insensitive), no < >', () => {
  assert.deepEqual(plain(V({ skills: [' Lighting ', 'lighting', 'Décor', ''] }).clean.skills), ['Lighting', 'Décor']);
  assert.deepEqual(plain(V({ skills: 'Sound, Stage ,sound' }).clean.skills), ['Sound', 'Stage']);
  const twenty = Array.from({ length: 20 }, (_, i) => 'skill ' + i);
  assert.equal(V({ skills: twenty }).ok, true);
  assert.equal(V({ skills: twenty.concat(['one more']) }).errors.skills, 'Add up to 20 skills.');
  assert.equal(V({ skills: twenty.concat(['SKILL 0']) }).ok, true, 'a duplicate does not count');
  assert.equal(V({ skills: ['x'.repeat(41)] }).errors.skills, 'A skill must be 40 characters or fewer.');
  assert.equal(V({ skills: ['<script>'] }).errors.skills, "A skill can't contain < or >.");
  assert.equal(V({ skills: [42] }).errors.skills, 'Each skill must be text.');
});
t('validate never sends unknown keys; complete() requires name + mobile; invalid input never reaches the RPC', async () => {
  const r = V({ full_name: 'A', phone: '9876543210', day_rate: 5000, emp_type: 'full_time', role: 'admin', org_id: 'x' });
  for (const k of Object.keys(r.clean)) assert.ok(['full_name', 'phone', 'whatsapp', 'whatsapp_same', 'job_title', 'department', 'skills', 'city', 'emergency_contact_name', 'emergency_contact_phone'].includes(k), k);
  const e = makeEnv({ path: '/dashboard', rpc: { my_profile_status: st(false, false, true), complete_my_profile: { data: { complete: true }, error: null }, update_my_profile: { data: { complete: false }, error: null } } });
  await e.S.init();
  await assert.rejects(e.S.profile.complete({ full_name: 'Ananya' }), (err) => err.code === 'profile_invalid' && err.field === 'phone');
  await assert.rejects(e.S.profile.update({ phone: '12' }), (err) => err.code === 'profile_invalid' && /Mobile number/.test(err.message));
  assert.equal(e.rpcCalls('complete_my_profile').length + e.rpcCalls('update_my_profile').length, 0);
  await e.S.profile.complete({ full_name: ' Ananya  Rao ', phone: '+91 98765 43210', whatsapp_same: true, skills: ['Lighting'], city: 'Hyderabad' });
  assert.deepEqual(plain(e.rpcCalls('complete_my_profile')[0][2]), { p_profile: { full_name: 'Ananya Rao', phone: '+919876543210', whatsapp_same: true, skills: ['Lighting'], city: 'Hyderabad' } });
  await e.S.profile.update({ job_title: 'Coordinator', whatsapp_same: false, whatsapp: '8765432109' });
  assert.deepEqual(plain(e.rpcCalls('update_my_profile')[0][2]), { p_profile: { whatsapp_same: false, whatsapp: '+918765432109', job_title: 'Coordinator' } });
});
t('mine() with 0041: my_profile() row (+ id alias), never the raw profiles table', async () => {
  const row = { user_id: UID, full_name: 'Ananya Rao', phone: '+919876543210', complete: true, skills: ['Sound'], avatar_path: null };
  const e = makeEnv({ path: '/dashboard', rpc: { my_profile_status: st(true, false, false), my_profile: { data: row, error: null } } });
  await e.S.init();
  const me = await e.S.profile.mine();
  assert.equal(me.id, UID); assert.equal(me.full_name, 'Ananya Rao'); assert.equal(me.complete, true);
  assert.ok(!e.calls.some((c) => c[0] === 'from' && c[1] === 'profiles'));
  assert.equal(e.S.profile.localMobile('+919876543210'), '9876543210');
  // the old helpers keep working
  assert.equal(typeof e.S.profile.setMine, 'function'); assert.equal(typeof e.S.profile.setName, 'function');
  assert.equal(e.S.profile.problem(''), 'A display name must be 1 to 80 characters.');
});

/* --------------------------------------------------- 3. profile photo */
t('photo type is decided by the file\'s first bytes (PNG / JPEG / WebP only)', () => {
  const sniff = makeEnv({ user: null, path: '/login', gated: false }).S.profile._sniffImage;
  assert.equal(sniff(new Uint8Array(PNG)), 'png');
  assert.equal(sniff(new Uint8Array(JPG)), 'jpeg');
  assert.equal(sniff(new Uint8Array(WEBP)), 'webp');
  for (const bad of [GIF, SVG, [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x41, 0x56, 0x49, 0x20], [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0, 0, 0, 0], [], [0x89, 0x50]])
    assert.equal(sniff(new Uint8Array(bad)), null);
  assert.equal(sniff(null), null);
});
t('centre-square crop, drawn at <= 512 px; storage key = <studio>/<me>/<uuid>.<png|jpg|webp> only', () => {
  const P = makeEnv({ user: null, path: '/login', gated: false }).S.profile;
  assert.deepEqual(plain(P._avatarCrop(1000, 600, 512)), { sx: 200, sy: 0, side: 600, size: 512 });
  assert.deepEqual(plain(P._avatarCrop(300, 400, 512)), { sx: 0, sy: 50, side: 300, size: 300 });
  assert.deepEqual(plain(P._avatarCrop(4000, 4000, 512)), { sx: 0, sy: 0, side: 4000, size: 512 });
  assert.equal(P._avatarCrop(0, 10, 512), null);
  const id = '99999999-8888-4777-8666-555555555555';
  assert.equal(P._avatarPath(ORG_ID, UID, id, 'webp'), ORG_ID + '/' + UID + '/' + id + '.webp');
  assert.equal(P._avatarPath(ORG_ID.toUpperCase(), UID, id, 'jpg'), ORG_ID + '/' + UID + '/' + id + '.jpg');
  for (const [o, u, i, x] of [['..', UID, id, 'png'], [ORG_ID, '../' + UID, id, 'png'], [ORG_ID, UID, id, 'gif'], [ORG_ID, UID, id, 'svg'], [ORG_ID, UID, 'x', 'png'], [null, UID, id, 'png'], [ORG_ID, UID, id + '/../a', 'png']])
    assert.equal(P._avatarPath(o, u, i, x), null, [o, u, i, x].join(' '));
});
t('photo guards run BEFORE anything is decoded or uploaded', async () => {
  const e = makeEnv({ path: '/dashboard', rpc: { my_profile_status: st(true, false, false) } });
  await e.S.init();
  const P = e.S.profile;
  const reject = (f, re) => assert.rejects(P.uploadAvatar(f), (err) => err.code === 'avatar_invalid' && re.test(err.message));
  await reject(null, /Choose a photo/);
  await reject({ name: 'x.png' }, /Choose a photo/);
  await reject(blob([1, 2, 3]), /empty or not a photo/);
  await reject(blob(GIF, 'image/png', 100), /PNG, JPEG or WebP/);
  await reject(blob(SVG, 'image/png'), /PNG, JPEG or WebP/);
  const huge = { size: 25 * 1024 * 1024, slice: () => blob(PNG) };
  await reject(huge, /under 20 MB/);
  assert.equal(e.calls.filter((c) => c[0] === 'upload').length, 0);
  assert.equal(e.rpcCalls('set_my_avatar').length, 0);
  const out = makeEnv({ user: null, path: '/login', gated: false });
  await out.S.init();
  await assert.rejects(out.S.profile.uploadAvatar(blob(PNG, 'image/png', 100)), (err) => err.code === 'avatar_unavailable');
});
function fakeCanvas(log, outBytes, outType, pad) {
  return () => ({
    width: 0, height: 0,
    getContext: () => ({ fillRect() {}, set fillStyle(v) {}, drawImage: (...a) => log.push(['draw', ...a.slice(1)]) }),
    toBlob: (cb, type, q) => { log.push(['toBlob', type, q]); cb(type === outType || !outType ? blob(outBytes, type, pad) : null); },
  });
}
t('upload: square <= 512 px WebP into MY folder (no overwrite), then set_my_avatar(path)', async () => {
  const log = [];
  const e = makeEnv({ path: '/dashboard', rpc: { my_profile_status: st(true, false, false), set_my_avatar: (a) => ({ data: a.p_path, error: null }) },
    bitmap: { width: 1200, height: 800, close() { log.push(['close']); } }, canvas: fakeCanvas(log, WEBP, 'image/webp', 5000) });
  await e.S.init();
  const path = await e.S.profile.uploadAvatar(blob(JPG, 'image/jpeg', 5000));
  assert.match(path, new RegExp('^' + ORG_ID + '/' + UID + '/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.webp$'));
  assert.deepEqual(log.find((x) => x[0] === 'draw'), ['draw', 200, 0, 800, 800, 0, 0, 512, 512]);
  const up = e.calls.find((c) => c[0] === 'upload');
  assert.equal(up[1], 'member-avatars');
  assert.equal(up[2], path);
  assert.equal(up[4].contentType, 'image/webp');
  assert.equal(up[4].upsert, false, 'never overwrites an existing file');
  assert.deepEqual(plain(e.rpcCalls('set_my_avatar')[0][2]), { p_path: path });
  assert.ok(log.some((x) => x[0] === 'close'), 'decoded bitmap released');
});
t('upload: falls back to JPEG (.jpg) when the browser can\'t make WebP; too big after every quality → refused', async () => {
  const log = [];
  const e = makeEnv({ path: '/dashboard', rpc: { my_profile_status: st(true, false, false), set_my_avatar: (a) => ({ data: a.p_path, error: null }) },
    bitmap: { width: 600, height: 600 }, canvas: fakeCanvas(log, JPG, 'image/jpeg', 100) });
  await e.S.init();
  const path = await e.S.profile.uploadAvatar(blob(PNG, 'image/png', 100));
  assert.match(path, /\.jpg$/);
  assert.equal(e.calls.find((c) => c[0] === 'upload')[4].contentType, 'image/jpeg');
  const big = makeEnv({ path: '/dashboard', rpc: { my_profile_status: st(true, false, false) },
    bitmap: { width: 600, height: 600 }, canvas: fakeCanvas([], WEBP, 'image/webp', 2 * 1024 * 1024) });
  await big.S.init();
  await assert.rejects(big.S.profile.uploadAvatar(blob(PNG, 'image/png', 100)), /small enough/);
  assert.equal(big.calls.filter((c) => c[0] === 'upload').length, 0);
  const tiny = makeEnv({ path: '/dashboard', rpc: { my_profile_status: st(true, false, false) },
    bitmap: { width: 20, height: 400 }, canvas: fakeCanvas([], WEBP, 'image/webp', 10) });
  await tiny.S.init();
  await assert.rejects(tiny.S.profile.uploadAvatar(blob(PNG, 'image/png', 100)), /too small/);
  const fake = makeEnv({ path: '/dashboard', rpc: { my_profile_status: st(true, false, false) },
    bitmap: { width: 600, height: 600 }, canvas: () => ({ getContext: () => ({ fillRect() {}, drawImage() {} }), toBlob: (cb) => cb(blob(GIF, 'image/webp', 10)) }) });
  await fake.S.init();
  await assert.rejects(fake.S.profile.uploadAvatar(blob(PNG, 'image/png', 100)), /converted|small enough/);
  assert.equal(fake.calls.filter((c) => c[0] === 'upload').length, 0, 'output is re-checked by its bytes before upload');
});
t('upload failure surfaces; set_my_avatar is not called for a file that never landed', async () => {
  const e = makeEnv({ path: '/dashboard', rpc: { my_profile_status: st(true, false, false) }, uploadError: { message: 'new row violates row-level security policy', statusCode: '403' },
    bitmap: { width: 600, height: 600 }, canvas: fakeCanvas([], WEBP, 'image/webp', 10) });
  await e.S.init();
  await assert.rejects(e.S.profile.uploadAvatar(blob(PNG, 'image/png', 100)), (err) => /row-level security/.test(err.message));
  assert.equal(e.rpcCalls('set_my_avatar').length, 0);
});
t('photo URLs: only our own bucket keys are signed, batched into one request, cached', async () => {
  const e = makeEnv({ path: '/dashboard', rpc: { my_profile_status: st(true, false, false) } });
  await e.S.init();
  const a = ORG_ID + '/' + UID + '/99999999-8888-4777-8666-555555555555.webp';
  const b = ORG_ID + '/' + UID + '/99999999-8888-4777-8666-555555555556.jpg';
  for (const bad of ['https://evil.com/x.png', 'data:image/png;base64,AAAA', '../' + a, a + '?x', 'x.png', null])
    assert.equal(await e.S.profile.avatarUrl(bad), null, String(bad));
  assert.equal(e.calls.filter((c) => c[0] === 'sign').length, 0);
  const urls = await e.S.profile.avatarUrls([a, b, a, 'https://evil.com/x.png']);
  assert.deepEqual(Object.keys(urls).sort(), [a, b].sort());
  const signs = e.calls.filter((c) => c[0] === 'sign');
  assert.equal(signs.length, 1, 'one batched request');
  assert.equal(signs[0][1], 'member-avatars');
  assert.ok(urls[a].startsWith('https://abcdefghijklmnopqrst.supabase.co/'));
  await e.S.profile.avatarUrl(a);
  assert.equal(e.calls.filter((c) => c[0] === 'sign').length, 1, 'served from cache');
});
t('remove photo clears the link only (set_my_avatar(null)); local/offline mode → features off', async () => {
  const e = makeEnv({ path: '/dashboard', rpc: { my_profile_status: st(true, false, false), set_my_avatar: { data: null, error: null } } });
  await e.S.init();
  assert.equal(await e.S.profile.removeAvatar(), null);
  assert.deepEqual(plain(e.rpcCalls('set_my_avatar')[0][2]), { p_path: null });
});

/* ------------------------------------------------- 4. static wiring */
t('profile-setup.html: protected page shell, no inline handlers, replace-only navigation, accessible', () => {
  const h = read('public/profile-setup.html');
  assert.match(h, /<html\b[^>]*\bclass="[^"]*\bauth-pending\b/);
  assert.match(h.slice(0, h.indexOf('<body')), /html\.auth-pending body[^{]*\{[^}]*visibility:\s*hidden/);
  for (const s of ['store-api.js', 'auth-ui.js', 'config.js']) assert.ok(h.includes('src="' + s), s);
  assert.doesNotMatch(h, /\son[a-z]+\s*=\s*["']/i, 'no inline event handlers (CSP)');
  assert.doesNotMatch(h, /location\.href\s*=|location\.assign\(|innerHTML/);
  assert.match(h, /location\.replace\(next\)/);
  assert.match(h, /BPStore\.profile\.setupNext\(\)/, 'next comes from the shared sanitiser');
  assert.match(h, /id="psSignOut"/);
  assert.match(h, /aria-labelledby="psTitle"/);
  assert.match(h, /name="robots" content="noindex/);
});
t('auth-ui: "Your profile" in the Account panel (display-name fallback kept), banner skips /profile-setup, 7-day snooze', () => {
  const a = read('public/auth-ui.js');
  assert.match(a, /function profileSection\(st, focusIt\)/);
  assert.match(a, /function displayNameSection\(st\)/, 'display-name section kept (pre-0041 fallback)');
  assert.match(a, /if \(!p \|\| !\("complete" in p\)\) \{ sec\.replaceWith\(displayNameSection\(st\)\); return; \}/);
  assert.match(a, /if \(page === "profile-setup"\) return;/);
  assert.match(a, /st\.profile\.snoozeNudge\(7\)/);
  assert.match(a, /openAccount\(\{ focus: "profile" \}\)/);
  assert.match(a, /renderMfaSection\(mfBody\)/, 'two-step section intact');
  assert.match(a, /\/reset-password\?mode=change/, 'password section intact');
  assert.match(a, /profileForm: profileForm/);
  const pf = a.slice(a.indexOf('function profileForm('), a.indexOf('function profileSection('));
  assert.doesNotMatch(pf, /innerHTML|insertAdjacentHTML|outerHTML/, 'form builds DOM with textContent only');
  assert.match(pf, /HP\.attach\(inputs\[k\]/, 'phones use the shared HelmPhone component (E.164)');
  assert.match(pf, /Phone verification will be available shortly — you can continue./, 'dormant WhatsApp verify lets the member continue');
});

/* ------------------------------------------------------------- run */
let pass = 0, fail = 0;
for (const [name, fn] of tests) {
  try { await fn(); pass++; console.log('ok - ' + name); }
  catch (e) { fail++; console.log('not ok - ' + name + ': ' + (e && e.message)); }
}
console.log(`\nprofile-setup: ${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
