// r26: "Continue with Google" ON helm.events (Google Identity Services + supabase.auth.signInWithIdToken).
// Runs public/google-gis.js and public/store-api.js in sandboxes with a STUB `google` object and a stub
// Supabase client (never real Google / Supabase), plus static checks of the page, config, CSP and headers.
import { readFileSync } from 'node:fs';
import { createHash, webcrypto } from 'node:crypto';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const root = new URL('..', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
const GIS_SRC = read('public/google-gis.js');
const STORE = read('public/store-api.js');
const LOGIN = read('public/login.html');
const CONFIG = read('public/config.js');
const CLIENT_ID = '326378207877-nkcq44qbfh4qavnv438ec6q5kjc6klib.apps.googleusercontent.com';
const tests = [];
const t = (name, fn) => tests.push([name, fn]);
const flush = () => new Promise((r) => setImmediate(r));

/* ------------------------------------------------ google-gis.js sandbox */
function el(tag) {
  const e = { tag, children: [], hidden: false, className: '', attrs: {}, listeners: {}, parentNode: null,
    classList: { set: new Set(), add(c) { this.set.add(c); }, remove(c) { this.set.delete(c); }, contains(c) { return this.set.has(c); } },
    setAttribute(k, v) { this.attrs[k] = String(v); }, addEventListener(k, f) { (this.listeners[k] ||= []).push(f); },
    click() { (this.listeners.click || []).forEach((f) => f()); },
    appendChild(c) { c.parentNode = this; this.children.push(c); if (this.onAppend) this.onAppend(c); return c; },
    insertBefore(c, ref) { c.parentNode = this; const i = this.children.indexOf(ref); this.children.splice(i < 0 ? this.children.length : i, 0, c); return c; },
    getBoundingClientRect() { return { width: 336 }; },
    querySelector(sel) { const walk = (n) => { for (const c of n.children) { if (c.tag === sel) return c; const f = walk(c); if (f) return f; } return null; }; return walk(this); },
    fire(k) { (this.listeners[k] || []).forEach((f) => f()); } };
  Object.defineProperty(e, 'nextSibling', { get() { const p = e.parentNode; if (!p) return null; return p.children[p.children.indexOf(e) + 1] || null; } });
  return e;
}
function gisEnv(o = {}) {
  const calls = [];
  const observers = [];
  const head = el('head'), body = el('body'), form = el('form'), button = el('button');
  form.appendChild(button);
  const google = { accounts: { id: {
    initialize(cfg) { calls.push(['initialize', cfg]); google._cfg = cfg; },
    // like the real GSI: an UNSTYLED placeholder (big svg + text) first, the button iframe a moment later
    renderButton(node, opts) { calls.push(['renderButton', node.id, opts]);
      const ph = el('div'); ph.appendChild(el('svg')); node.appendChild(ph); observers.forEach((f) => f());
      google._iframe = el('iframe');
      google._addIframe = () => { const w = el('div'); w.appendChild(google._iframe); node.appendChild(w); observers.forEach((f) => f()); };
      if (o.iframeNow !== false) setImmediate(() => { google._addIframe(); if (o.iframeLoads !== false) setImmediate(() => google._iframe.fire('load')); });
    },
    prompt() { calls.push(['prompt']); },
  } } };
  const win = {
    HELM_FEATURES: o.features || { googleGis: true }, HELM_GOOGLE: o.google || { clientId: CLIENT_ID },
    crypto: o.noCrypto ? undefined : webcrypto, TextEncoder, btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    setTimeout: (fn, ms) => { if (o.fireTimeouts || (ms === 8000 && o.fireShowTimeout)) setImmediate(fn); return 0; },
    MutationObserver: o.noMO ? undefined : function (cb) { this.observe = () => observers.push(() => cb([])); this.disconnect = () => { observers.length = 0; }; },
    setInterval: () => 1, clearInterval() {}, Uint8Array, Promise, Math, String, Array, Object,
    document: { createElement: (tag) => el(tag), head, documentElement: head, body },
  };
  head.onAppend = (s) => { calls.push(['script', s.src, s.async]);
    setImmediate(() => { if (o.scriptFails) s.onerror && s.onerror(); else { win.google = google; s.onload && s.onload(); } }); };
  win.window = win;
  vm.createContext(win);
  vm.runInContext(GIS_SRC, win, { filename: 'google-gis.js' });
  return { win, G: win.HelmGoogleGis, calls, form, button, google, observers };
}

t('enabled(): only with the flag ON + a well-formed public client ID + Web Crypto', () => {
  const { G } = gisEnv();
  assert.equal(G.enabled({ googleGis: true }, CLIENT_ID, webcrypto), true);
  assert.equal(G.enabled({ googleGis: false }, CLIENT_ID, webcrypto), false);
  assert.equal(G.enabled({}, CLIENT_ID, webcrypto), false, 'missing flag = off');
  assert.equal(G.enabled({ googleGis: true }, '', webcrypto), false);
  assert.equal(G.enabled({ googleGis: true }, 'evil.example.com', webcrypto), false);
  assert.equal(G.enabled({ googleGis: true }, CLIENT_ID, undefined), false);
});
t('nonce: raw (32 random bytes, base64url) for Supabase; SHA-256 hex of it for Google', async () => {
  const { G } = gisEnv();
  const a = await G.makeNonce(webcrypto), b = await G.makeNonce(webcrypto);
  assert.match(a.raw, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a.raw, b.raw, 'fresh every time');
  assert.equal(a.hashed, createHash('sha256').update(a.raw).digest('hex'));
  assert.match(a.hashed, /^[0-9a-f]{64}$/);
});
t('attach: loads ONLY https://accounts.google.com/gsi/client, initialises with the HASHED nonce + FedCM, renders Google\'s button', async () => {
  const e = gisEnv();
  const got = [];
  const ctl = e.G.attach({ button: e.button, root: e.form, needsAgree: () => false, onCredential: async (tok, raw) => got.push([tok, raw]) });
  assert.ok(ctl);
  assert.equal(await ctl.ready, true);
  assert.deepEqual(e.calls.filter((c) => c[0] === 'script').map((c) => c[1]), ['https://accounts.google.com/gsi/client']);
  const cfg = e.calls.find((c) => c[0] === 'initialize')[1];
  assert.equal(cfg.client_id, CLIENT_ID);
  assert.match(cfg.nonce, /^[0-9a-f]{64}$/, 'Google gets the hash');
  assert.equal(cfg.use_fedcm_for_button, true); assert.equal(cfg.use_fedcm_for_prompt, true);
  assert.equal(cfg.auto_select, false); assert.equal(cfg.ux_mode, 'popup');
  const rb = e.calls.find((c) => c[0] === 'renderButton');
  assert.equal(rb[1], 'gisBtn'); assert.equal(rb[2].text, 'continue_with'); assert.equal(rb[2].width, 336);
  assert.equal(await ctl.shown, true, 'shown once Google\'s iframe has loaded');
  assert.ok(e.form.classList.contains('gis-on'), 'classic button hidden by CSS while Google\'s is shown');
  assert.equal(ctl.active(), true);
  assert.ok(!e.calls.some((c) => c[0] === 'prompt'), 'no One Tap unless asked');
  // Google answers -> the page gets the ID token + the RAW nonce (whose hash Google saw)
  e.google._cfg.callback({ credential: 'h.p.s' });
  await flush();
  assert.equal(got.length, 1); assert.equal(got[0][0], 'h.p.s');
  assert.equal(createHash('sha256').update(got[0][1]).digest('hex'), cfg.nonce);
});
t('attach: a NEW account must tick the Terms first (shield over Google\'s button; a credential is not used)', async () => {
  const e = gisEnv();
  let agreed = false, blocked = 0; const got = [];
  const ctl = e.G.attach({ button: e.button, root: e.form, needsAgree: () => !agreed, onBlocked: () => blocked++, onCredential: async (tok) => got.push(tok) });
  await ctl.ready; await ctl.shown;
  const wrap = e.form.children.find((c) => c.className === 'gis-wrap');
  const shield = wrap.children.find((c) => c.className === 'gis-shield');
  assert.equal(shield.hidden, false, 'shield shown while the box is unticked');
  shield.click(); assert.equal(blocked, 1);
  e.google._cfg.callback({ credential: 'h.p.s' }); await flush();
  assert.equal(got.length, 0); assert.equal(blocked, 2);
  agreed = true; ctl.refresh();
  assert.equal(shield.hidden, true);
  e.google._cfg.callback({ credential: 'h.p.s' }); await flush();
  assert.equal(got.length, 1);
});
t('fallback: flag off / script blocked -> the classic redirect button stays; fallback() brings it back', async () => {
  const off = gisEnv({ features: { googleGis: false } });
  assert.equal(off.G.attach({ button: off.button, root: off.form, onCredential: async () => {} }), null);
  assert.ok(!off.calls.some((c) => c[0] === 'script'), 'nothing loaded from Google when off');
  const bad = gisEnv({ scriptFails: true });
  const c1 = bad.G.attach({ button: bad.button, root: bad.form, onCredential: async () => {} });
  assert.equal(await c1.ready, false);
  assert.ok(!bad.form.classList.contains('gis-on')); assert.equal(c1.active(), false);
  const ok = gisEnv();
  const c2 = ok.G.attach({ button: ok.button, root: ok.form, onCredential: async () => {} });
  await c2.ready; await c2.shown; c2.fallback();
  assert.ok(!ok.form.classList.contains('gis-on')); assert.equal(c2.active(), false);
  ok.google._cfg.callback({ credential: 'h.p.s' });   // ignored after fallback
});
t('no flash: Google\'s unstyled placeholder is NEVER visible - box stays gis-wait (invisible, classic button shown) until the iframe LOADS', async () => {
  const e = gisEnv({ iframeNow: false });
  const ctl = e.G.attach({ button: e.button, root: e.form, needsAgree: () => true, onCredential: async () => {} });
  assert.equal(await ctl.ready, true);
  const wrap = e.form.children.find((c) => /gis-wrap/.test(c.className));
  const slot = wrap.children.find((c) => c.className === 'gis-btn');
  assert.ok(slot.querySelector('svg'), 'stub drew the unstyled placeholder');
  assert.equal(wrap.className, 'gis-wrap gis-wait'); assert.equal(wrap.hidden, false, 'laid out (Google measures it) but gis-wait = invisible');
  assert.ok(!e.form.classList.contains('gis-on'), 'classic (styled) button still showing');
  assert.equal(ctl.active(), false);
  const shield = wrap.children.find((c) => c.className === 'gis-shield');
  assert.equal(shield.hidden, true, 'no shield while waiting');
  e.google._addIframe(); await flush();
  assert.equal(wrap.className, 'gis-wrap gis-wait', 'iframe present but not loaded yet: still hidden');
  e.google._iframe.fire('load');
  assert.equal(await ctl.shown, true);
  assert.equal(wrap.className, 'gis-wrap'); assert.ok(e.form.classList.contains('gis-on')); assert.equal(ctl.active(), true);
  assert.equal(shield.hidden, false, 'Terms shield applies once shown');
});
t('no iframe within 8 s -> classic button stays (fallback), a late iframe is ignored', async () => {
  const e = gisEnv({ iframeNow: false, fireShowTimeout: true });
  const ctl = e.G.attach({ button: e.button, root: e.form, onCredential: async () => {} });
  await ctl.ready;
  assert.equal(await ctl.shown, false);
  const wrap = e.form.children.find((c) => /gis-wrap/.test(c.className));
  assert.equal(wrap.hidden, true); assert.ok(!e.form.classList.contains('gis-on')); assert.equal(ctl.active(), false);
  e.google._addIframe(); e.google._iframe.fire('load'); await flush();
  assert.ok(!e.form.classList.contains('gis-on'), 'stays on the classic button');
});
t('login.html CSS: Google\'s box is fixed 44px + clipped, invisible + click-through while waiting, svg capped at 20px', () => {
  assert.match(LOGIN, /\.gis-wrap\{position:relative;display:flex;align-items:center;justify-content:center;height:44px;overflow:hidden\}/);
  assert.match(LOGIN, /\.gis-wrap\.gis-wait\{margin-top:-44px;visibility:hidden;opacity:0;pointer-events:none\}/);
  assert.match(LOGIN, /\.gis-btn svg\{max-width:20px;max-height:20px\}/);
  assert.match(LOGIN, /\.gis-btn \*:not\(iframe\):not\(:has\(iframe\)\)\{display:none\}/, 'only Google\'s iframe (and its wrappers) ever show');
  assert.match(GIS_SRC, /wrap\.className = "gis-wrap gis-wait"; wrap\.hidden = true;/);
});
t('CSP: Google\'s inline <style> hash only on the policies that allow its stylesheet (best effort)', () => {
  const v = JSON.parse(read('vercel.json'));
  const H = "'sha256-RU4sU0AaS8IBGZx8XrGt/pa9A5SLA3dQszGeqT5L3Kw='";
  let n = 0;
  for (const r of v.headers) {
    const csp = (r.headers || []).find((h) => h.key === 'Content-Security-Policy');
    if (!csp) continue;
    const elem = (csp.value.match(/style-src-elem [^;]*/) || [''])[0];
    // codeql[js/incomplete-url-substring-sanitization] -- false positive: test assertion comparing the repo's own CSP directive text, not a runtime sanitizer on untrusted input.
    assert.equal(elem.includes(H), elem.includes('https://accounts.google.com/gsi/style'), r.source);
    if (elem.includes(H)) n++;
    assert.ok(!/style-src-elem [^;]*'unsafe-inline'/.test(csp.value));
  }
  assert.ok(n >= 2);
});
t('One Tap only when asked AND on plain sign-in', async () => {
  const e = gisEnv();
  await e.G.attach({ button: e.button, root: e.form, oneTap: true, isSignin: () => false, onCredential: async () => {} }).ready;
  assert.ok(!e.calls.some((c) => c[0] === 'prompt'));
  const f = gisEnv();
  await f.G.attach({ button: f.button, root: f.form, oneTap: true, isSignin: () => true, onCredential: async () => {} }).ready;
  assert.ok(f.calls.some((c) => c[0] === 'prompt'));
});

/* ------------------------------------------------ store-api.js sandbox (stub Supabase) */
function memStore(init) { const m = new Map(Object.entries(init || {})); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; }
function storeEnv(o = {}) {
  const calls = [];
  let session = o.user ? { user: o.user, access_token: 'x' } : null;
  const auth = {
    async getSession() { return { data: { session } }; },
    onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; },
    async signInWithIdToken(arg) { calls.push(['signInWithIdToken', arg]); if (o.idErr) return { data: {}, error: o.idErr };
      session = { user: { id: 'g-1', email: 'g@gmail.test', app_metadata: { provider: 'google' } }, access_token: 'x' }; return { data: { user: session.user, session }, error: null }; },
    async signOut(arg) { calls.push(['signOut', arg || null]); session = null; return { error: null }; },
    async refreshSession() { return { data: { session }, error: null }; },
    mfa: { async getAuthenticatorAssuranceLevel() { return { data: { currentLevel: 'aal1', nextLevel: 'aal1' }, error: null }; }, async listFactors() { return { data: { all: [] }, error: null }; } },
  };
  const client = { auth, async rpc(name) { calls.push(['rpc', name]); return { data: null, error: null }; },
    from() { const q = { select: () => q, eq: () => q, order: () => q, single: async () => ({ data: { role: 'admin' }, error: null }) }; return q; } };
  const loc = { pathname: '/login', search: '', hash: '', origin: 'https://www.helm.events', href: '', hostname: 'www.helm.events', replace(u) { calls.push(['location.replace', u]); }, reload() {} };
  const doc = { readyState: 'loading', addEventListener() {}, removeEventListener() {}, currentScript: { src: 'https://www.helm.events/store-api.js?v=1' },
    createElement: (tag) => ({ tag, style: {}, setAttribute() {}, appendChild() {}, addEventListener() {}, querySelector: () => null, remove() {} }),
    head: { appendChild() {} }, body: { appendChild() {}, insertBefore() {} }, documentElement: { setAttribute() {}, getAttribute() { return 'light'; } },
    querySelector: () => null, querySelectorAll: () => [], getElementById: () => null, hidden: false };
  const win = {
    SUPABASE_CONFIG: Object.assign({ url: 'https://abcdefghijklmnopqrst.supabase.co', anonKey: 'anon' }, o.cfg || {}),
    supabase: { createClient: () => client }, localStorage: memStore(o.ls), sessionStorage: memStore(),
    location: loc, history: { replaceState() {} }, document: doc, navigator: { onLine: true },
    fetch: async () => ({ status: 200, ok: true, json: async () => ({}) }), addEventListener() {}, removeEventListener() {},
    setTimeout: (fn) => { try { fn(); } catch (e) {} return 0; }, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    atob: (b) => Buffer.from(b, 'base64').toString('binary'),
    console, Date, Promise, URLSearchParams, URL, JSON, Math, Object, Array, String, Number, RegExp, Error, Map, Set,
  };
  win.window = win; win.globalThis = win;
  vm.createContext(win);
  vm.runInContext(STORE, win, { filename: 'store-api.js' });
  return { win, S: win.BPStore, calls };
}
const TOKEN = ['eyJhbGciOiJSUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'c2lnbmF0dXJlLXBsYWNlaG9sZGVy'].join('.');   // shape only, never a real token
const NONCE = 'A'.repeat(20) + '_-' + 'b'.repeat(21);

t('signInWithGoogleIdToken: provider google + the token + the RAW nonce; session starts; no CAPTCHA token needed', async () => {
  const e = storeEnv({ cfg: { captcha: { provider: 'turnstile', siteKey: '0x4AAAAAAA-test-site-key' } } });
  await e.S.init();
  const u = await e.S.auth.signInWithGoogleIdToken(TOKEN, NONCE);
  assert.equal(u.id, 'g-1');
  const c = e.calls.find((x) => x[0] === 'signInWithIdToken')[1];
  assert.deepEqual(JSON.parse(JSON.stringify(c)), { provider: 'google', token: TOKEN, nonce: NONCE });
  assert.equal(e.S.auth.user().id, 'g-1');
  assert.ok(JSON.parse(e.win.localStorage.getItem('bp_session_start')).uid === 'g-1', 'session clock started');
});
t('signInWithGoogleIdToken: a bad token / nonce shape is refused before any request', async () => {
  const e = storeEnv();
  await e.S.init();
  await assert.rejects(e.S.auth.signInWithGoogleIdToken('not-a-jwt', NONCE), (x) => x.code === 'google_token_invalid');
  await assert.rejects(e.S.auth.signInWithGoogleIdToken(TOKEN, 'short'), (x) => x.code === 'google_nonce_invalid');
  await assert.rejects(e.S.auth.signInWithGoogleIdToken(TOKEN, ''), (x) => x.code === 'google_nonce_invalid');
  assert.ok(!e.calls.some((x) => x[0] === 'signInWithIdToken'));
});
t('signInWithGoogleIdToken: errors - reserved helm.events address, rate limit, anything else = fall back', async () => {
  const r = storeEnv({ idErr: { message: 'Addresses on helm.events are reserved for the Helm team.', status: 400 } });
  await r.S.init();
  await assert.rejects(r.S.auth.signInWithGoogleIdToken(TOKEN, NONCE), (x) => x.code === 'reserved_domain');
  const l = storeEnv({ idErr: { message: 'Request rate limit reached', status: 429 } });
  await l.S.init();
  await assert.rejects(l.S.auth.signInWithGoogleIdToken(TOKEN, NONCE), (x) => x.code === 'rate_limited');
  const a = storeEnv({ idErr: { message: 'Unacceptable audience in id_token', status: 400 } });
  await a.S.init();
  await assert.rejects(a.S.auth.signInWithGoogleIdToken(TOKEN, NONCE), (x) => x.code === 'google_idtoken_failed' && !/audience/i.test(x.message));
});
t('signInWithGoogleIdToken: an earlier session in this browser is ended (local) first', async () => {
  const e = storeEnv({ user: { id: 'u-old', email: 'old@a.test' } });
  await e.S.init();
  await e.S.auth.signInWithGoogleIdToken(TOKEN, NONCE);
  const i = e.calls.findIndex((x) => x[0] === 'signOut'), j = e.calls.findIndex((x) => x[0] === 'signInWithIdToken');
  assert.ok(i >= 0 && i < j); assert.deepEqual(JSON.parse(JSON.stringify(e.calls[i][1])), { scope: 'local' });
});

/* ------------------------------------------------ static wiring */
t('config.js: googleGis ON for helm.events + www only; public client ID; One Tap off; no secret', () => {
  assert.match(CONFIG, /googleGis: \/\^\(www\\\.\)\?helm\\\.events\$\/\.test\(/);
  const re = /^(www\.)?helm\.events$/;
  for (const h of ['helm.events', 'www.helm.events']) assert.ok(re.test(h));
  for (const h of ['helm-v01.vercel.app', 'localhost', 'evilhelm.events', 'helm.events.evil.com']) assert.ok(!re.test(h), h);
  assert.ok(CONFIG.includes('clientId: "' + CLIENT_ID + '"'));
  assert.match(CONFIG, /oneTap: false/);
  assert.ok(!/client_?secret\s*[:=]\s*["'][^"']/i.test(CONFIG) && !/GOCSPX-/.test(CONFIG), 'never the client secret');
});
t('login.html: loads google-gis.js; GIS sign-in reloads into the SAME return address as the redirect flow; classic button kept', () => {
  // r26 speed: deferred, AFTER store-api / auth-ui / signup-flow (the page script runs at DOMContentLoaded, after them)
  assert.match(LOGIN, /<script src="\/google-gis\.js\?v=\d+" defer><\/script>/);
  const at = (re) => LOGIN.search(re);
  assert.ok(at(/store-api\.js\?v=\d+" defer/) < at(/<script src="\/google-gis\.js/) && at(/auth-ui\.js\?v=\d+" defer/) < at(/<script src="\/google-gis\.js/) && at(/signup-flow\.js\?v=\d+" defer/) < at(/<script src="\/google-gis\.js/));
  assert.ok(at(/<script src="\/google-gis\.js/) < at(/document\.addEventListener\("DOMContentLoaded"/));
  assert.match(LOGIN, /GIS = window\.HelmGoogleGis \? HelmGoogleGis\.attach\(\{/);
  assert.match(LOGIN, /await BPStore\.auth\.signInWithGoogleIdToken\(token, rawNonce\)/);
  assert.match(LOGIN, /location\.replace\(location\.origin\+"\/login\.html\?"\+\(tok\?"invite="\+encodeURIComponent\(tok\)\+"&":""\)\+"next="\+encodeURIComponent\(nextUrl\(\)\)\)/);
  assert.match(LOGIN, /needsAgree: \(\)=>mode==="signup" && !J\(\) && !\$\("#agree"\)\.checked/);
  assert.match(LOGIN, /BPSignupFlow\.stashTerms\("google"\)/);
  assert.match(LOGIN, /GIS\.fallback\(\)/);
  assert.match(LOGIN, /if\(GIS\) GIS\.refresh\(\);/);
  assert.match(LOGIN, /signInWithGoogle\(location\.origin\+"\/login\.html\?"/, 'redirect flow still there as the fallback');
  assert.match(LOGIN, /\.gis-on #googleBtn\{display:none\}/);
});
t('CSP + COOP: Google only on the sign-in rule it shares with the public forms (exact /gsi/ paths); COOP relaxed on sign-in pages only', async () => {
  const v = JSON.parse(read('vercel.json'));
  const { scriptSrcProblem } = (await import('node:module')).createRequire(import.meta.url)('../scripts/csp-hashes.cjs');
  for (const r of v.headers) {
    const csp = (r.headers || []).find((h) => h.key === 'Content-Security-Policy');
    if (!csp) continue;
    const isAuth = /login/.test(r.source) && !r.has;
    const isStaging = !!(r.has && r.has[0].value === 'helm-v01.vercel.app');
    if (isAuth) {
      assert.match(csp.value, /script-src [^;]*https:\/\/accounts\.google\.com\/gsi\/client[ ;]/, r.source);
      assert.match(csp.value, /frame-src [^;]*https:\/\/accounts\.google\.com\/gsi\/[ ;]/, r.source);
      assert.match(csp.value, /connect-src [^;]*https:\/\/accounts\.google\.com\/gsi\/[ ;]/, r.source);
      assert.match(csp.value, /style-src [^;]*https:\/\/accounts\.google\.com\/gsi\/style[ ;]/, r.source);
    } else if (!isStaging) {
      assert.ok(!/accounts\.google\.com/.test(csp.value), 'no Google on ' + r.source);
    }
    assert.ok(!/accounts\.google\.com(?!\/gsi\/)/.test(csp.value), 'only /gsi/ paths');
  }
  // COOP same-origin-allow-popups (Google's pop-up without FedCM) on the sign-in pages ONLY; everything else keeps same-origin
  const coop = (p) => { let val = null; for (const r of v.headers) if (!r.has && new RegExp('^' + r.source + '$').test(p)) for (const h of r.headers) if (h.key === 'Cross-Origin-Opener-Policy') val = h.value; return val; };
  for (const p of ['/login', '/signup', '/reset-password', '/login.html', '/reset-password.html']) assert.equal(coop(p), 'same-origin-allow-popups', p);
  for (const p of ['/', '/index', '/contact-sales', '/dashboard', '/checkout', '/quotes.html']) assert.equal(coop(p), 'same-origin', p);
  assert.equal(scriptSrcProblem("script-src 'self' https://accounts.google.com/gsi/client", '/dashboard') !== '', true, 'refused off the sign-in pages');
  assert.equal(scriptSrcProblem("script-src 'self' https://accounts.google.com/gsi/client", '/(login|reset-password|signup)'), '');
  const h = read('public/_headers');
  assert.match(h, /\/login\n  ! Content-Security-Policy\n  Content-Security-Policy: [^\n]*accounts\.google\.com\/gsi\/client[^\n]*\n  ! Cross-Origin-Opener-Policy\n  Cross-Origin-Opener-Policy: same-origin-allow-popups/);
  assert.match(read('public/trusted-types.js'), /'https:\/\/accounts\.google\.com\/gsi\/client'/);
  assert.match(read('server.js'), /if \(page === 'login' \|\| page === 'reset-password'\) h\['Cross-Origin-Opener-Policy'\] = AUTH_COOP;/);
});
t('npm test runs this file', () => { assert.match(read('package.json'), /node test\/r26-google-gis\.test\.mjs/); });

let n = 0;
for (const [name, fn] of tests) {
  try { await fn(); n++; console.log('ok -', name); }
  catch (e) { console.error('not ok -', name); console.error(e); process.exitCode = 1; }
}
console.log(`\nr26-google-gis: ${n}/${tests.length} passed`);
if (n !== tests.length) process.exit(1);
