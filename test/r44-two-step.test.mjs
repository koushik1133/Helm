// r44-two-step.test.mjs - help studio admins set up two-step BEFORE they hit the 0285 block (SQL 0291):
//  A. auth-ui.js in a vm with a tiny DOM: the calm banner ("Protect your studio...", "Set up now (2 min)") shows for an
//     admin without two-step on the dashboard and Settings only; never for non-admins, admins who already have it,
//     free-trial studios or other pages; dismissed = quiet for 7 days. The guided set-up: 1 install an app, 2 scan the
//     QR (or type the key), 3 enter the 6-digit code, done (+ recovery note); a wrong code says so; closing early
//     resolves false; already on -> "already on". The bell deep link (#two-step-setup) opens it.
//  B. store-api.js withStepUp (vm): an R35_SETUP_2STEP refusal offers "Set up two-step now", opens the guided set-up
//     and then retries the SAME change once (carries on where they were); closed / "Not now" -> refused, no retry.
//     teamStatus answer -> { user id: yes / no }; the bell notice links to the set-up.
//  C. control.html Settings -> Team: a "Two-step" badge next to each ADMIN only (on / not set up), from the 0291 RPC.
//  D. SQL 0291 + APPLY + MANIFEST + run-all + release lists + the owner file.
// No network.
import { readFileSync, existsSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const root = new URL('..', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
const AUTHUI = read('public/auth-ui.js'), API = read('public/store-api.js'), CC = read('public/control.html');
const SQL = read('supabase/migrations/0291_r44_admin_two_step.sql');
const tests = [];
const t = (name, fn) => tests.push([name, fn]);
const flush = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

/* ------------------------------------------------------------------ A. tiny DOM + auth-ui */
function memStore(init) {
  const m = new Map(Object.entries(init || {}));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _m: m };
}
function tinyDom(htmlClasses) {
  const byId = new Map();
  function node(tag) {
    const n = {
      tagName: String(tag).toUpperCase(), children: [], parentNode: null, attrs: {}, style: {}, listeners: {}, _text: '', className: '', value: '', disabled: false,
      get isConnected() { let p = this; while (p.parentNode) p = p.parentNode; return p === body; },
      get hidden() { return 'hidden' in this.attrs; }, set hidden(v) { if (v) this.attrs.hidden = ''; else delete this.attrs.hidden; },
      get id() { return this.attrs.id || ''; },
      setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id') byId.set(String(v), this); if (k === 'class') this.className = String(v); },
      getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
      removeAttribute(k) { delete this.attrs[k]; },
      appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.children.push(c); return c; },
      insertBefore(c, ref) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; const i = this.children.indexOf(ref); if (i < 0) this.children.push(c); else this.children.splice(i, 0, c); return c; },
      removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; return c; },
      remove() { if (this.parentNode) this.parentNode.removeChild(this); },
      get firstChild() { return this.children[0] || null; },
      get textContent() { return this._text + this.children.map((c) => c.textContent).join(' '); },
      set textContent(v) { this._text = String(v); this.children.forEach((c) => { c.parentNode = null; }); this.children = []; },
      addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
      removeEventListener() {},
      click() { (this.listeners.click || []).forEach((f) => f({ preventDefault() {}, target: this })); },
      key(k) { (this.listeners.keydown || []).forEach((f) => f({ key: k, preventDefault() {}, defaultPrevented: false })); },
      focus() {}, select() {}, scrollIntoView() {}, matches: () => false, contains: () => false, getClientRects: () => [], getBoundingClientRect: () => ({ height: 0 }),
      querySelector() { return null; }, querySelectorAll() { return []; },
      classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
    };
    return n;
  }
  const body = node('body'), head = node('head');
  const all = (n, out = []) => { out.push(n); n.children.forEach((c) => all(c, out)); return out; };
  const events = [];
  const doc = {
    readyState: 'complete', body, head, createElement: node, createElementNS: (ns, t2) => node(t2), createTextNode: (s) => Object.assign(node('#text'), { _text: String(s) }),
    getElementById: (id) => { const n = byId.get(id); return n && n.isConnected ? n : null; },
    querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, removeEventListener() {},
    dispatchEvent: (e) => { events.push(e.type); return true; }, createRange: () => ({ selectNodeContents() {} }),
    documentElement: { classList: { contains: (c) => (htmlClasses || []).includes(c), add() {}, remove() {} }, setAttribute() {}, getAttribute() { return null; } },
  };
  return { doc, body, all, events, cls: (r, c) => all(r).filter((n) => (' ' + n.className + ' ').includes(' ' + c + ' ')),
    buttons: (r, label) => all(r).filter((n) => n.tagName === 'BUTTON' && n._text === label) };
}
function env(o = {}) {
  const dom = tinyDom(o.htmlClasses);
  let on = !!o.on; const calls = [];
  const mfa = {
    verifiedTotp: async () => (on ? [{ id: 'f-1', status: 'verified' }] : []),
    enrollTotp: async () => { calls.push('enroll'); if (o.enrollError) throw o.enrollError; return { factorId: 'f-9', qr: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>', secret: 'JBSWY3DPEHPK3PXP', uri: 'otpauth://totp/helm.events:a%40studio.test?secret=JBSWY3DPEHPK3PXP&issuer=helm.events' }; },
    verify: async (id, code) => { calls.push(['verify', id, code]); if (code !== '123456') { const e = new Error("That code didn't work. Codes change every 30 seconds."); e.code = 'mfa_invalid'; throw e; } on = true; return true; },
    resetInfo: async () => null,
    requiredForAdmins: () => !!o.required,
  };
  const ls = o.localStorage || memStore();
  const win = { document: dom.doc, console, setTimeout: (fn, ms) => { if (!(ms >= 3000)) try { fn(); } catch (e) { console.error(e); } return 0; },
    clearTimeout() {}, sessionStorage: memStore(), localStorage: ls, CustomEvent: function (type) { this.type = type; },
    addEventListener() {}, removeEventListener() {}, location: { pathname: o.path || '/dashboard', search: '', hash: o.hash || '', replace() {} },
    history: { replaceState: (a, b, url) => calls.push(['replaceState', url]) },
    navigator: { userAgent: 'Mozilla/5.0', clipboard: { writeText: async () => {} } },
    BPStore: {
      auth: { user: () => ({ id: 'u-1', email: 'a@studio.test' }), role: () => o.role || 'admin', hasPassword: () => true, mfa,
        isPlatformAdmin: async () => false, sessionLimits: { config: () => ({ idleMs: 0, maxMs: 0 }) }, myAuthInfo: async () => null },
      subscription: { trial: async () => (o.trial ? { status: 'trial' } : { status: 'active' }) },
    } };
  win.window = win; win.global = win;
  vm.createContext(win);
  vm.runInContext(AUTHUI, win, { filename: 'auth-ui.js' });
  return Object.assign({ win, UI: win.HelmAuthUI, calls, ls, isOn: () => on }, dom);
}
const text = (n) => n.textContent.replace(/\s+/g, ' ');
const bannerOf = (u) => u.doc.getElementById('hauMfaNudge');

t('A1 banner: an admin without two-step on the dashboard sees the calm notice + "Set up now (2 min)"', async () => {
  const u = env(); u.UI._adminTwoStep(); await flush();
  const b = bannerOf(u);
  assert.ok(b, 'banner shown');
  assert.match(text(b), /Protect your studio: set up two-step sign-in\./);
  assert.match(text(b), /You'll need it to change payment details and other sensitive settings\./);
  assert.equal(u.buttons(b, 'Set up now (2 min)').length, 1);
  assert.ok(!/ urgent| warn/.test(b.className), 'calm (no warning tone)');
  assert.equal(u.doc.getElementById('hauForce'), null, 'never blocking: two-step is not made mandatory for sign-in');
});
t('A2 banner: Settings (control.html and the pretty /<studio>/settings) too; never other pages', async () => {
  for (const path of ['/control.html', '/sparkv/settings']) { const u = env({ path }); u.UI._adminTwoStep(); await flush(); assert.ok(bannerOf(u), path); }
  for (const path of ['/quotes.html', '/chat.html', '/sparkv/quotes']) { const u = env({ path }); u.UI._adminTwoStep(); await flush(); assert.equal(bannerOf(u), null, path); }
});
t('A3 banner: never for non-admins, admins who already have two-step, or a free-trial studio', async () => {
  for (const role of ['manager', 'sales', 'coordinator', 'crew']) { const u = env({ role }); u.UI._adminTwoStep(); await flush(); assert.equal(bannerOf(u), null, role); }
  const on = env({ on: true }); on.UI._adminTwoStep(); await flush(); assert.equal(bannerOf(on), null, 'already on');
  const tr = env({ trial: true }); tr.UI._adminTwoStep(); await flush(); assert.equal(bannerOf(tr), null, 'trial (server answer)');
  const tr2 = env({ htmlClasses: ['helm-trial'] }); tr2.UI._adminTwoStep(); await flush(); assert.equal(bannerOf(tr2), null, 'trial (cached class)');
});
t('A4 banner: dismissed -> quiet for 7 days (per person), then back', async () => {
  const ls = memStore();
  const u = env({ localStorage: ls }); u.UI._adminTwoStep(); await flush();
  const x = u.all(bannerOf(u)).find((n) => n.tagName === 'BUTTON' && n.attrs['aria-label'] === 'Dismiss - remind me in 7 days');
  assert.ok(x, 'dismiss button says 7 days'); x.click();
  assert.equal(bannerOf(u), null, 'gone at once');
  const saved = JSON.parse(ls.getItem('helm_note_twostep'));
  assert.equal(saved.uid, 'u-1');
  const days = (saved.until - Date.now()) / 86400000; assert.ok(days > 6.9 && days <= 7, String(days));
  const again = env({ localStorage: ls }); again.UI._adminTwoStep(); await flush(); assert.equal(bannerOf(again), null, 'still quiet on the next visit');
  ls.setItem('helm_note_twostep', JSON.stringify({ uid: 'u-1', until: Date.now() - 1000 }));
  const later = env({ localStorage: ls }); later.UI._adminTwoStep(); await flush(); assert.ok(bannerOf(later), 'back after 7 days');
});
t('A5 guided set-up from the banner: install app -> scan / key -> 6-digit code -> done; the banner goes; true', async () => {
  const u = env(); u.UI._adminTwoStep(); await flush();
  u.buttons(bannerOf(u), 'Set up now (2 min)')[0].click(); await flush();
  const ov = u.doc.getElementById('hauTwoStep');
  assert.ok(ov, 'set-up opened');
  assert.match(text(ov), /Step 1 of 3/);
  assert.match(text(ov), /Install an authenticator app/);
  assert.match(text(ov), /Google Authenticator/); assert.match(text(ov), /Microsoft Authenticator/);
  assert.match(text(ov), /Another admin in your studio or Helm support \(security@helm\.events\) can help/);
  assert.ok(!u.calls.includes('enroll'), 'nothing is created until step 2');
  u.buttons(ov, 'I have the app')[0].click(); await flush();
  assert.match(text(ov), /Step 2 of 3/); assert.match(text(ov), /Scan the QR code/);
  assert.equal(u.cls(ov, 'hau-qr').length, 1, 'QR image');
  assert.equal(u.doc.getElementById('hauTsKey')._text, 'JBSWY3DPEHPK3PXP', 'typed key');
  assert.equal(u.buttons(ov, 'Copy').length, 1);
  u.buttons(ov, 'Back')[0].click(); await flush(); assert.match(text(ov), /Step 1 of 3/);
  u.buttons(ov, 'I have the app')[0].click(); await flush();
  assert.equal(u.calls.filter((c) => c === 'enroll').length, 1, 'going back and forth keeps the same set-up');
  u.buttons(ov, 'Next: enter the code')[0].click(); await flush();
  assert.match(text(ov), /Step 3 of 3/); assert.match(text(ov), /Enter the 6-digit code/);
  const inp = u.doc.getElementById('hauTsCode');
  assert.equal(inp.attrs.inputmode, 'numeric'); assert.equal(inp.attrs.autocomplete, 'one-time-code'); assert.equal(inp.attrs.maxlength, '6');
  inp.value = '111111'; u.buttons(ov, 'Verify & turn on')[0].click(); await flush();
  assert.match(text(ov), /That code didn't work/); assert.equal(u.isOn(), false);
  inp.value = '123456'; u.buttons(ov, 'Verify & turn on')[0].click(); await flush();
  assert.equal(u.isOn(), true);
  assert.match(text(ov), /Two-step sign-in is on/); assert.match(text(ov), /All set/);
  assert.match(text(ov), /can help you get back in/, 'recovery note on the last screen too');
  assert.equal(bannerOf(u), null, 'banner gone');
  assert.ok(u.events.includes('helm:two-step-on'), 'the page is told (Team badge refresh)');
  assert.deepEqual(u.calls.find((c) => Array.isArray(c) && c[0] === 'verify' && c[2] === '123456'), ['verify', 'f-9', '123456']);
});
t('A6 guided set-up: the promise says true when done, false when closed early; already on -> "already on"', async () => {
  const u = env();
  let p = u.UI.openTwoStepSetup(); await flush();
  const ov = u.doc.getElementById('hauTwoStep');
  u.buttons(ov, 'Not now')[0].click(); assert.equal(await p, false); assert.equal(u.doc.getElementById('hauTwoStep'), null);
  p = u.UI.openTwoStepSetup({ doneLabel: 'Continue with my change', reason: 'This change needs two-step sign-in.' }); await flush();
  const ov2 = u.doc.getElementById('hauTwoStep');
  assert.match(text(ov2), /This change needs two-step sign-in\./);
  u.buttons(ov2, 'I have the app')[0].click(); await flush();
  u.buttons(ov2, 'Next: enter the code')[0].click(); await flush();
  u.doc.getElementById('hauTsCode').value = '123456'; u.buttons(ov2, 'Verify & turn on')[0].click(); await flush();
  u.buttons(ov2, 'Continue with my change')[0].click();
  assert.equal(await p, true);
  const on = env({ on: true }); const p3 = on.UI.openTwoStepSetup(); await flush();
  assert.match(text(on.doc.getElementById('hauTwoStep')), /Two-step sign-in is already on/);
  assert.ok(!on.calls.includes('enroll'));
  on.buttons(on.doc.getElementById('hauTwoStep'), 'Done')[0].click(); assert.equal(await p3, true);
});
t('A7 guided set-up: Escape / the close button close it; set-up switched off on the site -> clear message + Try again', async () => {
  const u = env(); const p = u.UI.openTwoStepSetup(); await flush();
  u.doc.getElementById('hauTwoStep').key('Escape'); assert.equal(await p, false);
  const err = Object.assign(new Error('Two-step set-up is switched off for this Helm site right now.'), { code: 'mfa_unavailable' });
  const v = env({ enrollError: err }); v.UI.openTwoStepSetup(); await flush();
  const ov = v.doc.getElementById('hauTwoStep');
  v.buttons(ov, 'I have the app')[0].click(); await flush();
  assert.match(text(ov), /switched off for this Helm site/); assert.equal(v.buttons(ov, 'Try again').length, 1);
  assert.equal(v.buttons(ov, 'Next: enter the code')[0].disabled, true, 'cannot go on without a code to scan');
});
t('A8 the bell deep link (#two-step-setup) opens the guided set-up and tidies the address', async () => {
  const u = env({ hash: '#two-step-setup' }); u.UI.mountAppChrome(); await flush();
  assert.ok(u.doc.getElementById('hauTwoStep'), 'opened');
  assert.ok(u.calls.some((c) => Array.isArray(c) && c[0] === 'replaceState' && c[1] === '/dashboard'));
});
t('A9 phone width: the set-up uses the Account dialog layout + one-column rules at <= 560px', () => {
  assert.match(AUTHUI, /"\.bpui-dialog\.hau-acc\.hau-ts\{width:min\(560px,100%\)\}"/);
  assert.match(AUTHUI, /@media \(max-width:560px\)\{\.hau-ts-prog\{/);
  assert.match(AUTHUI, /\.hau-enr\{grid-template-columns:minmax\(0,1fr\);justify-items:center/, 'QR above the key on phones');
});

/* ------------------------------------------------------------------ B. store-api withStepUp + helpers */
const stepUpSrc = API.slice(API.indexOf('  const STEPUP_TEXT = {'), API.indexOf('  /* ---------------- client approval: OTP + consent + payment'));
function stepUpEnv(o) {
  const log = [];
  const cx = { log, global: null, console };
  cx.global = cx;
  cx.BPUI = {
    prompt: async (msg, opt) => { log.push(['prompt', opt.title]); return '123456'; },
    confirm: async (msg, opt) => { log.push(['confirm', opt.okLabel, opt.cancelLabel, msg]); return !!o.confirm; },
  };
  cx.HelmAuthUI = { openAccount: () => log.push(['openAccount']),
    openTwoStepSetup: async (opts) => { log.push(['setup', opts.doneLabel, opts.reason]); return !!o.setupDone; } };
  cx.BPStore = { auth: { mfa: { challenge: async (c) => { log.push(['challenge', c]); } } } };
  vm.createContext(cx);
  vm.runInContext(stepUpSrc + '\nglobal.withStepUp = withStepUp;', cx);
  return cx;
}
const r35err = (word) => Object.assign(new Error(word + ': server text'), { code: '42501' });
t('B1 R35_SETUP_2STEP -> "Set up two-step now" -> guided set-up -> the SAME change retried once and saved', async () => {
  const cx = stepUpEnv({ confirm: true, setupDone: true }); let calls = 0;
  const out = await cx.withStepUp(async () => { calls++; if (calls === 1) throw r35err('R35_SETUP_2STEP'); return 'saved'; });
  assert.equal(out, 'saved'); assert.equal(calls, 2);
  assert.equal(cx.log[0][0], 'confirm'); assert.equal(cx.log[0][1], 'Set up two-step now'); assert.equal(cx.log[0][2], 'Not now');
  assert.match(cx.log[0][3], /Set up two-step verification on your account first/);
  assert.deepEqual(cx.log[1].slice(0, 2), ['setup', 'Continue with my change']);
  assert.match(cx.log[1][2], /carries on with your change/);
  assert.ok(!cx.log.some((x) => x[0] === 'prompt'), 'no extra code prompt: the set-up itself was the fresh code');
});
t('B2 set-up closed early, or "Not now" -> refused with the friendly set-up message, never retried', async () => {
  for (const o of [{ confirm: true, setupDone: false }, { confirm: false }]) {
    const cx = stepUpEnv(o); let calls = 0;
    await assert.rejects(cx.withStepUp(async () => { calls++; throw r35err('R35_SETUP_2STEP'); }),
      (e) => e.stepUp === 'setup' && /Set up two-step verification/.test(e.message));
    assert.equal(calls, 1, JSON.stringify(o));
    assert.equal(cx.log.some((x) => x[0] === 'setup'), !!o.confirm);
  }
});
t('B3 after set-up the retry still asks for a fresh code (rare) -> one code prompt, then the change', async () => {
  const cx = stepUpEnv({ confirm: true, setupDone: true }); let calls = 0;
  const out = await cx.withStepUp(async () => { calls++; if (calls === 1) throw r35err('R35_SETUP_2STEP'); if (calls === 2) throw r35err('R35_REAUTH'); return 'ok'; });
  assert.equal(out, 'ok'); assert.equal(calls, 3);
  assert.deepEqual(cx.log.filter((x) => x[0] === 'prompt' || x[0] === 'challenge'), [['prompt', 'Confirm with two-step'], ['challenge', '123456']]);
});
t('B4 store-api: Team status RPC (null when 0291 is missing / not allowed), bell notice -> set-up link, versions', () => {
  assert.match(API, /async twoStepStatus\(\) \{[\s\S]{0,200}supa\.rpc\("studio_two_step_status"\)/);
  assert.match(API, /if \(error\.code === "PGRST202" \|\| error\.code === "42883" \|\| error\.code === "42501"\) return null;/);
  assert.match(API, /out\[r\.user_id\] = r\.two_step === true/);
  assert.match(API, /if \(ev === "two_step_intro"\) return "dashboard\.html#two-step-setup";/);
  assert.match(API, /const AUTH_UI_VERSION = "56";/);
  assert.match(read('public/dashboard.html'), /store-api\.js\?v=314/); assert.match(CC, /store-api\.js\?v=314/);
});

/* ------------------------------------------------------------------ C. Settings -> Team badge */
const ccFrom = CC.indexOf('  const ucId=(u)=>u.user_id||u.id;');
const ccTo = CC.indexOf('    return { head, body, shown:rows.length, total:list.length };\n  }', CC.indexOf('function ucTable(list, o){')) + '    return { head, body, shown:rows.length, total:list.length };\n  }'.length;
const ucSrc = CC.slice(ccFrom, ccTo);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function ucTable(list, o) {
  const cx = { esc, BPStore: undefined, HelmPhone: undefined }; vm.createContext(cx);
  vm.runInContext(ucSrc + '\nthis.ucTable = ucTable;', cx);
  return cx.ucTable(list, o);
}
const members = [{ id: 'a1', email: 'owner@s.in', role: 'admin', full_name: 'Owner' }, { id: 'a2', email: 'ravi@s.in', role: 'admin', full_name: 'Ravi' },
  { id: 's1', email: 'sam@s.in', role: 'sales', full_name: 'Sam' }];
t('C1 Team: each ADMIN gets "Two-step: on" / "Two-step: not set up"; other roles none (both table layouts)', () => {
  for (const profiles of [true, false]) {
    const out = ucTable(members, { profiles, meId: 'a1', roles: ['admin', 'sales'], canEdit: true, twoStep: { a1: true, a2: false, s1: false } });
    const row = (id) => out.body.split('<tr').find((r) => r.includes(`data-id="${id}"`)) || '';
    assert.match(row('a1'), /<span class="ts-badge on"[^>]*>Two-step: on<\/span>/, 'profiles=' + profiles);
    assert.match(row('a2'), /<span class="ts-badge off"[^>]*>Two-step: not set up<\/span>/);
    assert.ok(!/ts-badge/.test(row('s1')), 'not for non-admins');
  }
});
t('C2 Team: no answer (older database / not allowed) -> no badge at all, the list still works', () => {
  const out = ucTable(members, { profiles: true, meId: 'a1', roles: ['admin', 'sales'], canEdit: true, twoStep: null });
  assert.ok(!/ts-badge/.test(out.body)); assert.equal(out.total, 3);
});
t('C3 Team wiring: fetched with the list for admins only (never blocks it); refreshed when two-step is turned on', () => {
  assert.match(CC, /const tsP=isAdmin&&BPStore\.auth\.admin\.twoStepStatus\?BPStore\.auth\.admin\.twoStepStatus\(\)\.catch\(\(\)=>null\):Promise\.resolve\(null\);/);
  assert.match(CC, /canEdit:isAdmin, twoStep:ucTwoStep,/);
  assert.match(CC, /document\.addEventListener\("helm:two-step-on"/);
  assert.match(CC, /\.ts-badge\.off\{/);
});
t('C4 with r33 (0283): the badge sits next to the Team view (owner / deactivated / Deactivate buttons) in the same table', () => {
  assert.match(CC, /canEdit:isAdmin, twoStep:ucTwoStep,\s*\n\s*q:\$\("#uc_q"\)\.value, filter:ucProfiles\?\$\("#uc_f"\)\.value:"", team\}\);/);
  assert.match(CC, /let ucRows=\[\], ucProfiles=false, ucTeam=null, ucTwoStep=null;/);
  assert.match(CC, /\$\{roleSel\(u,self\)\}\$\{ts\(u\)\}/);
  assert.match(CC, /\/\/ r33 \(0283\): "Remove" is now Deactivate/);
});
t('C5 r33 Team actions + two-step: withStepUp asks once; team-safety.js never asks a second time (cancel = refused)', async () => {
  const src = read('public/team-safety.js');
  const cx = { window: {}, console }; cx.window = cx; vm.createContext(cx); vm.runInContext(src, cx);
  const T = cx.HelmTeam; let prompts = 0; const deps = { prompt: async () => { prompts++; return '123456'; }, mfa: { challenge: async () => {} } };
  // withStepUp already handled it (the person cancelled its prompt / the set-up): refused at once, no second prompt
  const handled = Object.assign(new Error('Enter a fresh two-step code'), { hint: 'reauth', stepUp: 'reauth', cancelled: true });
  await assert.rejects(T.call(async () => { throw handled; }, deps), (e) => e === handled);
  assert.equal(prompts, 0);
  // a plain r33 "reauth" refusal (no withStepUp in between) is still asked for once and retried
  let n = 0; const r = await T.call(async () => { if (n++ === 0) throw Object.assign(new Error('x'), { hint: 'reauth' }); return 'ok'; }, deps);
  assert.equal(r, 'ok'); assert.equal(prompts, 1);
});

/* ------------------------------------------------------------------ D. SQL + paste file */
t('D1 SQL 0291: own studio + admins only; yes / no only; notice owner-run, once, bell only; additive; ASCII', () => {
  assert.match(SQL, /returns table\(user_id uuid, two_step boolean\)/);
  assert.match(SQL, /v_org := public\.current_org_id\(\);\n  if v_org is null or not coalesce\(public\.is_admin\(\), false\) then/);
  assert.match(SQL, /where p\.org_id = v_org/);
  assert.match(SQL, /grant execute on function public\.studio_two_step_status\(\) to authenticated;/);
  assert.match(SQL, /revoke all on function public\.two_step_intro_send\(boolean\) from authenticated;/);
  assert.match(SQL, /two_step_intro_send\(p_dry_run boolean default true\)/);
  assert.match(SQL, /'via', 'comms'/); assert.doesNotMatch(SQL.replace(/--[^\n]*/g, ''), /helm_notice_outbox/);
  assert.match(SQL, /raise exception 'STOP 0291: apply 0285 first/);
  const code = SQL.replace(/--[^\n]*/g, '');
  assert.doesNotMatch(code, /\bdelete\s+from\b/i); assert.doesNotMatch(code, /\bdrop\s+(table|column|policy|function)\b/i); assert.doesNotMatch(code, /\btruncate\b/i);
  assert.doesNotMatch(code, /\bupdate\s+public\./i, 'no existing row is changed');
  assert.doesNotMatch(SQL, /[^\x00-\x7F]/, 'ASCII only');
});
t('D2 APPLY-0291: migration verbatim between begin / commit + VERIFY rows; MANIFEST, run-all, release lists; owner file', () => {
  const APPLY = read('supabase/APPLY-0291.sql');
  assert.ok(APPLY.includes('begin;\n' + SQL + 'commit;'));
  assert.match(APPLY, /-- VERIFY \(every row must say ok = true\)/);
  assert.match(APPLY, /STOP 0291: apply 0285 first/);
  assert.doesNotMatch(APPLY, /[^\x00-\x7F]/, 'ASCII only'); assert.doesNotMatch(APPLY, /create temp/i);
  assert.ok(read('supabase/migrations/MANIFEST').includes('forward  supabase/migrations/0291_r44_admin_two_step.sql'));
  assert.match(read('scripts/db-test/run-all.sh'), /R44-TWO-STEP-0291: ALL PASS \\\(22\/22\\\)/);
  assert.match(read('test/release-1019.test.mjs'), /'0285', '0291'[,\]]/); assert.match(read('test/release-1020.test.mjs'), /'0285', '0291'[,\]]/);
  const owner = new URL('file:///Users/koushikgoudshaganti/Desktop/Agency/Helm/APPLY-0291.sql');
  if (existsSync(owner)) assert.equal(readFileSync(owner, 'utf8'), APPLY);
});

let pass = 0, fail = 0;
for (const [name, fn] of tests) {
  try { await fn(); pass++; console.log('ok - ' + name); }
  catch (e) { fail++; console.log('not ok - ' + name + ': ' + (e && e.stack || e)); }
}
console.log(`\nr44-two-step: ${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
