// Onboarding checkout (0056) — front end. public/store-api.js runs in a vm sandbox with a
// stub Supabase client + stub fetch + stub Razorpay (no network, no real credentials):
//  * gate: a NEW studio owner → /checkout?next=… before any app page paints; members,
//    older studios, clients, 0056-not-installed and network failures never blocked;
//    /checkout itself never loops; profile-setup comes first
//  * billing validation mirrors SQL (trim, required, GSTIN), errors classified as
//    validation / declined / security (generic) / dormant / cancelled
//  * pay: edge function → Razorpay Standard Checkout (exact script URL) → server verify;
//    dormant → trial; never any card fields in our markup
//  * CSP / Trusted Types: Razorpay allowed on /checkout ONLY
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const root = new URL('..', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
const SRC = read('public/store-api.js');
const tests = [];
const t = (name, fn) => tests.push([name, fn]);
const ORG_ID = '11111111-2222-4333-8444-555555555555';
const UID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const co = (required, reason) => ({ data: { required, reason: reason || (required ? 'needs_checkout' : 'member'), is_admin: true, has_subscription: !required }, error: null });
const MISSING = { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.my_checkout_status without parameters in the schema cache' } };
const DONE_PROFILE = { data: { complete: true, required: false, nudge: false }, error: null };

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
  const el = (tag) => (tag === 'canvas' && canvas) ? canvas() : ({ tag, style: {}, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, appendChild() {}, addEventListener() {}, querySelector: () => null, remove() {}, set src(v) { this.srcVal = v; }, get src() { return this.srcVal || ''; } });
  const doc = {
    readyState: 'complete', addEventListener() {}, removeEventListener() {}, currentScript: { src: 'https://www.helm.events/store-api.js?v=1' },
    createElement: el, head: { appendChild(n) { calls.push(['script', n.srcVal]); if (o.onScript) o.onScript(n, win); } }, body,
    documentElement: { setAttribute() {}, getAttribute() { return 'light'; },
      classList: { contains: (c) => cls.has(c), add: (c) => { cls.add(c); calls.push(['hide']); }, remove: (c) => { cls.delete(c); calls.push(['reveal']); } } },
    querySelector: () => null, querySelectorAll: () => [], getElementById: () => null,
  };
  const win = {
    SUPABASE_CONFIG: Object.assign({ url: 'https://abcdefghijklmnopqrst.supabase.co', anonKey: 'anon' }, o.cfg || {}),
    supabase: { createClient: () => client },
    localStorage: memStore(o.ls), sessionStorage: memStore(o.ss),
    location: loc, document: doc, navigator: { onLine: true },
    fetch: o.fetch || (async () => ({ ok: false, status: 503, json: async () => ({}) })),
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


/* ------------------------------------------------------- 1. gate */
t('NEW studio owner: hidden → replace /checkout?next=<page> before the page shows', async () => {
  const e = makeEnv({ path: '/quotes', search: '?q=1', rpc: { my_profile_status: DONE_PROFILE, my_checkout_status: co(true) } });
  assert.equal(await settles(e.S.init()), false, 'page code never runs');
  assert.deepEqual(e.replaced(), ['/checkout?next=' + encodeURIComponent('quotes.html?q=1')]);
  assert.equal(e.gated(), true, 'no flash');
  assert.equal(e.rpcCalls('my_checkout_status').length, 1);
  assert.equal(e.win.sessionStorage.getItem('bp_sess_checkout'), null, '"must check out" is never cached');
});
t('invited member / older studio: page shows, answer cached per tab', async () => {
  for (const reason of ['member', 'existing_studio', 'subscribed']) {
    const e = makeEnv({ path: '/dashboard', rpc: { my_profile_status: DONE_PROFILE, my_checkout_status: co(false, reason) } });
    assert.equal(await e.S.init(), 'supabase');
    assert.deepEqual(e.replaced(), []); assert.equal(e.gated(), false);
    assert.ok(e.win.sessionStorage.getItem('bp_sess_checkout'));
  }
});
t('profile step comes first: must-complete profile → /profile-setup, not /checkout', async () => {
  const e = makeEnv({ path: '/dashboard', rpc: { my_profile_status: { data: { complete: false, required: true, nudge: false }, error: null }, my_checkout_status: co(true) } });
  await settles(e.S.init());
  assert.match(e.replaced()[0], /^\/profile-setup\?next=/);
  const p = makeEnv({ path: '/profile-setup', search: '?next=dashboard', rpc: { my_profile_status: { data: { complete: false, required: true, nudge: false }, error: null }, my_checkout_status: co(true) } });
  assert.equal(await p.S.init(), 'supabase'); assert.deepEqual(p.replaced(), [], 'profile-setup itself shows');
});
t('/checkout: shown when required; otherwise straight on to ?next= (no loop, never itself)', async () => {
  const a = makeEnv({ path: '/checkout', search: '?next=quotes', rpc: { my_profile_status: DONE_PROFILE, my_checkout_status: co(true) } });
  assert.equal(await a.S.init(), 'supabase'); assert.deepEqual(a.replaced(), []); assert.equal(a.gated(), false);
  const b = makeEnv({ path: '/checkout', search: '?next=quotes', rpc: { my_profile_status: DONE_PROFILE, my_checkout_status: co(false, 'subscribed') } });
  await settles(b.S.init()); assert.deepEqual(b.replaced(), ['quotes.html']);
  const S = b.S;
  for (const raw of ['checkout', '/checkout', 'checkout.html', 'checkout?next=dashboard']) assert.equal(S.auth.safeNext(raw), 'dashboard.html', raw);
});
t('0056 not installed (PGRST202) or network failure: never blocks the app', async () => {
  const m = makeEnv({ path: '/dashboard', rpc: { my_profile_status: DONE_PROFILE, my_checkout_status: MISSING } });
  assert.equal(await m.S.init(), 'supabase'); assert.deepEqual(m.replaced(), []);
  const n = makeEnv({ path: '/dashboard', rpc: { my_profile_status: DONE_PROFILE, my_checkout_status: { data: null, error: { code: '', message: 'Failed to fetch' } } } });
  assert.equal(await n.S.init(), 'supabase'); assert.deepEqual(n.replaced(), []);
  assert.equal(n.win.sessionStorage.getItem('bp_sess_checkout'), null, 'unknown is not cached');
});
t('gateDecision is pure: client role / missing / not required → none', () => {
  const S = makeEnv({ path: '/login', gated: false }).S;
  assert.equal(S.checkout.gateDecision({ required: true }, 'dashboard', 'client'), 'none');
  assert.equal(S.checkout.gateDecision({ missing: true }, 'dashboard', 'admin'), 'none');
  assert.equal(S.checkout.gateDecision(null, 'dashboard', 'admin'), 'none');
  assert.equal(S.checkout.gateDecision({ required: true }, 'checkout', 'admin'), 'none');
  assert.equal(S.checkout.gateDecision({ required: true }, 'profile-setup', 'admin'), 'none');
  assert.equal(S.checkout.gateDecision({ required: true }, 'dashboard', 'admin'), 'checkout');
});
t('login + profile-setup route a new owner on to /checkout', () => {
  assert.match(read('public/login.html'), /BPStore\.checkout\.routeIfRequired\(nextUrl\(\)\)/);
  assert.match(read('public/profile-setup.html'), /BPStore\.checkout\.routeIfRequired\(next\)/);
});

/* ------------------------------------------------------- 2. validation + errors */
t('billing validation mirrors SQL: trims, required *, GSTIN format, < > refused', () => {
  const S = makeEnv({ path: '/login', gated: false }).S;
  const ok = plain(S.checkout.validate({ legal_business_name: '  Studio   C  ', gstin: ' 36abcde1234f1z5 ', billing_address: ' 1 Road \n Hyd ', state: ' Telangana ', country: 'in' }));
  assert.equal(ok.ok, true); assert.equal(ok.clean.legal_business_name, 'Studio C'); assert.equal(ok.clean.gstin, '36ABCDE1234F1Z5'); assert.equal(ok.clean.country, 'IN');
  const bad = plain(S.checkout.validate({ legal_business_name: '', gstin: 'XYZ', billing_address: '', state: '', country: '' }));
  assert.deepEqual(Object.keys(bad.errors).sort(), ['billing_address', 'country', 'gstin', 'legal_business_name', 'state']);
  assert.ok(S.checkout.validate({ legal_business_name: '<b>x</b>', billing_address: 'a', state: 's', country: 'IN' }).errors.legal_business_name);
  assert.ok(S.checkout.validate({ legal_business_name: 'x', gstin: '36ABCDE1234F1Z5', billing_address: 'a', state: 's', country: 'US' }).errors.gstin, 'GSTIN only for IN');
});
t('saveBilling never sends an invalid payload; sends terms version (server stamps time)', async () => {
  const e = makeEnv({ path: '/login', gated: false });
  await e.S.init();
  await assert.rejects(e.S.checkout.saveBilling({ legal_business_name: '' }, '2026-10-08'), (x) => x.kind === 'validation');
  assert.equal(e.rpcCalls('my_studio_account_update').length, 0);
  await e.S.checkout.saveBilling({ legal_business_name: 'S', billing_address: 'a', state: 's', country: 'IN' }, '2026-10-08');
  const sent = plain(e.rpcCalls('my_studio_account_update')[0][2].p_account);
  assert.equal(sent.terms_version_accepted, '2026-10-08'); assert.ok(!('terms_accepted_at' in sent));
});
t('errors classified: validation shown, declined retry, security generic, dormant, cancelled, network', () => {
  const S = makeEnv({ path: '/login', gated: false }).S;
  assert.deepEqual(plain(S.checkout.classify({ kind: 'validation', message: 'please accept the Terms of Service first' })), { kind: 'validation', message: 'please accept the Terms of Service first' });
  assert.equal(S.checkout.classify({ code: '22023', message: 'GSTIN is not valid' }).kind, 'validation');
  const sec = [{ kind: 'security', message: 'payment_risk_check_failed' }, { code: '42501', message: 'not authorized' }, { status: 429 }, { message: 'JWT expired' }].map((x) => plain(S.checkout.classify(x)));
  for (const c of sec) { assert.equal(c.kind, 'security'); assert.doesNotMatch(c.message, /risk|jwt|authori/i); }
  assert.equal(new Set(sec.map((c) => c.message)).size, 1, 'one generic message');
  assert.equal(S.checkout.classify({ kind: 'declined', status: 502 }).kind, 'declined');
  assert.equal(S.checkout.classify({ kind: 'dormant' }).kind, 'dormant');
  assert.equal(S.checkout.classify({ kind: 'cancelled' }).kind, 'cancelled');
  assert.equal(S.checkout.classify(new TypeError('Failed to fetch')).kind, 'network');
  // Razorpay payment.failed: fraud/risk → security; card declined → declined
  assert.equal(S.checkout.failure({ error: { code: 'BAD_REQUEST_ERROR', reason: 'payment_risk_check_failed', description: 'x' } }).kind, 'security');
  assert.equal(S.checkout.failure({ error: { code: 'GATEWAY_ERROR', reason: 'payment_failed', description: 'Card declined by bank' } }).kind, 'declined');
  assert.equal(S.checkout.failure({ error: { description: '<img src=x>' } }).message.includes('<'), false);
});

/* ------------------------------------------------------- 3. pay flow */
function payEnv(o = {}) {
  const fetchLog = [];
  const env = makeEnv({ path: '/login', gated: false, cfg: { liveChannels: { pay: true } },
    fetch: async (url, init) => {
      const body = JSON.parse(init.body); fetchLog.push({ url, body, auth: init.headers.Authorization });
      if (body.action === 'verify') return { ok: true, status: 200, json: async () => (o.verify || { verified: true }) };
      return o.begin || { ok: true, status: 200, json: async () => ({ key_id: 'rzp_test_KEY', subscription_id: 'sub_NEW123456' }) };
    },
    onScript: (n, win) => {
      if (!/razorpay/.test(String(n.srcVal))) return;
      win.Razorpay = function (opts) { env.rzOpts = opts; this.handlers = {}; this.on = (ev, fn) => { this.handlers[ev] = fn; };
        this.open = () => { const self = this; setImmediate(() => o.outcome ? o.outcome(opts, self.handlers) : opts.handler({ razorpay_payment_id: 'pay_ABC123456', razorpay_subscription_id: 'sub_NEW123456', razorpay_signature: 'f'.repeat(64) })); }; };
      setImmediate(() => n.onload && n.onload());
    } });
  env.fetchLog = fetchLog;
  return env;
}
t('pay: edge fn → exact Razorpay script → modal (subscription mode) → server verify', async () => {
  const e = payEnv(); await e.S.init();
  const v = await e.S.checkout.pay('starter', 'yearly', { name: 'Studio C', email: 'o@c.test' });
  assert.equal(v.verified, true);
  assert.deepEqual(e.calls.filter((c) => c[0] === 'script' && /razorpay/.test(String(c[1]))).map((c) => c[1]), ['https://checkout.razorpay.com/v1/checkout.js']);
  assert.equal(e.rzOpts.key, 'rzp_test_KEY'); assert.equal(e.rzOpts.subscription_id, 'sub_NEW123456');
  assert.equal(e.rzOpts.name, 'Helm Events'); assert.equal(e.rzOpts.theme.color, '#6C4CF1');
  assert.ok(!('amount' in e.rzOpts), 'amount comes from the subscription, never the browser');
  assert.deepEqual(e.fetchLog.map((f) => f.body.action || 'create'), ['create', 'verify']);
  assert.deepEqual(plain(e.fetchLog[0].body), { plan: 'starter', interval: 'yearly' });
  assert.equal(e.fetchLog[1].body.razorpay_signature, 'f'.repeat(64));
  assert.match(e.fetchLog[0].url, /\/functions\/v1\/create-subscription-checkout$/);
  assert.ok(e.win.sessionStorage.getItem('bp_sess_checkout'), 'gate will let them in');
});
t('pay: modal closed → cancelled; payment.failed → declined / security; dormant (503) → dormant', async () => {
  let e = payEnv({ outcome: (opts) => opts.modal.ondismiss() }); await e.S.init();
  await assert.rejects(e.S.checkout.pay('starter', 'monthly'), (x) => x.kind === 'cancelled');
  assert.equal(e.fetchLog.length, 1, 'no verify after cancel');
  e = payEnv({ outcome: (opts, h) => h['payment.failed']({ error: { code: 'GATEWAY_ERROR', reason: 'payment_failed', description: 'Declined' } }) }); await e.S.init();
  await assert.rejects(e.S.checkout.pay('starter', 'monthly'), (x) => x.kind === 'declined');
  e = payEnv({ outcome: (opts, h) => h['payment.failed']({ error: { code: 'BAD_REQUEST_ERROR', reason: 'payment_risk_check_failed' } }) }); await e.S.init();
  await assert.rejects(e.S.checkout.pay('starter', 'monthly'), (x) => x.kind === 'security');
  e = payEnv({ begin: { ok: false, status: 503, json: async () => ({ kind: 'dormant', dormant: true, error: 'Online payment is being enabled' }) } }); await e.S.init();
  await assert.rejects(e.S.checkout.pay('starter', 'monthly'), (x) => e.S.checkout.classify(x).kind === 'dormant');
  assert.ok(!e.calls.some((c) => c[0] === 'script' && /razorpay/.test(String(c[1]))), 'Razorpay never loaded when dormant');
});
t('payLive needs config.js liveChannels.pay AND HQ online_payments_live; bypass needs config flag', async () => {
  const off = makeEnv({ path: '/login', gated: false });
  assert.equal(off.S.checkout.payLive({ online_payments_live: true }), false);
  assert.equal(off.S.checkout.bypassEnabled(), false);
  const on = makeEnv({ path: '/login', gated: false, cfg: { liveChannels: { pay: true }, onboarding: { allowPaymentBypass: true } } });
  assert.equal(on.S.checkout.payLive({ online_payments_live: false }), false);
  assert.equal(on.S.checkout.payLive({ online_payments_live: true }), true);
  assert.equal(on.S.checkout.bypassEnabled(), true);
  assert.match(read('public/config.js'), /onboarding:\s*\{\s*allowPaymentBypass:\s*true\s*\}/);
});
t('trial: payment_pending / bypass sources only; marks the gate done', async () => {
  const e = makeEnv({ path: '/login', gated: false, rpc: { my_start_trial: { data: { result: 'started' }, error: null } } });
  await e.S.init();
  await e.S.checkout.startTrial('payment_pending', 'starter');
  await e.S.checkout.startTrial('anything-else');
  assert.deepEqual(e.rpcCalls('my_start_trial').map((c) => c[2].p_source), ['payment_pending', 'bypass']);
});

/* ------------------------------------------------------- 4. page + policy */
t('checkout page: gated, no card/UPI/bank fields, no inline handlers/styles, textContent only', () => {
  const h = read('public/checkout.html'), js = read('public/checkout.js');
  assert.match(h, /<html[^>]*class="auth-pending"/);
  assert.doesNotMatch(h + js, /card.?number|cvv|cvc|expiry|autocomplete="cc-|upi id|ifsc|netbanking/i);
  assert.doesNotMatch(h, /\sstyle="/); assert.doesNotMatch(h, /\son[a-z]+=/i);
  assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  assert.match(h, /Skip payment \(testing only\)/); assert.match(h, /id="coTest"[^>]*hidden/);
  assert.match(h, /href="\/terms"/); assert.match(h, /href="\/privacy"/); assert.match(h, /href="\/refund-policy"/);
});
t('legal pages: draft note only in an HTML comment (never visible)', () => {
  for (const p of ['terms', 'privacy', 'refund-policy']) {
    const h = read('public/' + p + '.html');
    assert.match(h, /<!--[^>]*DRAFT[^>]*lawyer[^>]*-->/i, p);
    assert.doesNotMatch(h.replace(/<!--[\s\S]*?-->/g, ''), /lawyer|draft/i, p + ' shows no draft text');
  }
});
t('CSP + Trusted Types: Razorpay exact script on /checkout only', () => {
  const require = createRequire(import.meta.url);
  const { CSP, CSP_BY_PAGE } = require('../server.js');
  assert.equal(CSP_BY_PAGE.checkout, 'checkout');
  assert.match(CSP.checkout, /script-src 'self' https:\/\/checkout\.razorpay\.com\/v1\/checkout\.js /);
  assert.match(CSP.checkout, /frame-src [^;]*https:\/\/api\.razorpay\.com/);
  assert.match(CSP.checkout, /connect-src [^;]*https:\/\/api\.razorpay\.com/);
  for (const k of Object.keys(CSP)) if (k !== 'checkout') assert.doesNotMatch(CSP[k], /razorpay/, k);
  const v = JSON.parse(read('vercel.json'));
  for (const r of v.headers) for (const h of r.headers) if (/content-security-policy/i.test(h.key) && /razorpay/.test(h.value))
    assert.match(r.source, /^\/checkout/, 'razorpay only on /checkout, got ' + r.source);
  assert.ok(v.headers.some((r) => r.source === '/checkout' && r.headers.some((h) => /checkout\.razorpay\.com\/v1\/checkout\.js/.test(h.value))));
  assert.match(read('public/trusted-types.js'), /'https:\/\/checkout\.razorpay\.com\/v1\/checkout\.js'/);
});

/* ------------------------------------------------------------- run */
let pass = 0, fail = 0;
for (const [name, fn] of tests) {
  try { await fn(); pass++; console.log('ok - ' + name); }
  catch (e) { fail++; console.log('not ok - ' + name + ': ' + (e && e.message)); }
}
console.log(`\nonboarding-checkout: ${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
