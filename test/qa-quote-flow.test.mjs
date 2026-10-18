// qa-quote-flow (local QA of release 1018, staging): B6 coupon survives a reload, B7 "Reduce guest count"
// saves without a false conflict, B19 one status label, B20 hall-size error on step 7 (once), B21 WhatsApp
// test mode in the trial, B28 copy / rounding / date consistency. Pure pieces run in a vm; page wiring static.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const require = createRequire(import.meta.url);
const J = (x) => JSON.parse(JSON.stringify(x));
const tests = []; const t = (n, f) => tests.push([n, f]);
const FLOW = read('public/flow.html'), CAP = read('public/capacity-shortage.js'), EV = read('public/event.html');
// text between two markers (first occurrence)
const between = (s, a, b) => { const i = s.indexOf(a); assert.ok(i >= 0, 'marker ' + a); const j = s.indexOf(b, i + a.length); assert.ok(j > i, 'marker ' + b); return s.slice(i, j); };

/* ------------------------------------------------------------------ B6 coupon */
function couponHarness({ coupons, pricing, field }) {
  const code = between(FLOW, '  let COUPONS=[], couponsLoaded=false', '  // India audit');
  const els = { q_coupon: { value: field || '' }, q_couponMsg: { textContent: '', style: {} } };
  const ctx = { renders: 0 };
  const fn = new Function('ctx', 'BPStore', '$', 'esc', 'fTax', 'renderPrice', 'document',
    'let ev=ctx.ev, loading=ctx.loading;\n' + code + '\nreturn { loadCoupons, applyCoupon, state:()=>({COUPONS, couponsLoaded, appliedCoupon, appliedCouponCode}), normCoupon };');
  ctx.ev = { pricing: pricing || {} }; ctx.loading = false;
  const api = fn(ctx, { coupons: { list: async () => coupons }, tax: { money: (v) => 'Rs ' + v } },
    (s) => els[s.replace('#', '')] || null, (x) => String(x), () => ({}), () => { ctx.renders++; }, { getElementById: () => null });
  return { api, els, ctx };
}
t('B6: a saved coupon re-applies once the list has loaded (was "No such coupon code" on reload)', async () => {
  const { api, els } = couponHarness({ coupons: [{ code: 'DEMO-WELCOME10', kind: 'percent', value: 10 }], pricing: { couponCode: 'demo-welcome10' } });
  els.q_coupon.value = 'demo-welcome10';
  await api.loadCoupons(); api.applyCoupon();
  const s = api.state();
  assert.deepEqual(J(s.appliedCoupon), { kind: 'percent', value: 10 });
  assert.equal(s.appliedCouponCode, 'DEMO-WELCOME10');   // stored in the coupon's own (upper-case) spelling
  assert.match(els.q_couponMsg.textContent, /^Applied: 10% off/);
});
t('B6: before the list loads, the coupon stored on the quote (pricing.coupon) keeps the saved total', () => {
  const { api, els } = couponHarness({ coupons: [], pricing: { couponCode: 'DEMO-WELCOME10', coupon: { kind: 'percent', value: 10 } } });
  els.q_coupon.value = 'DEMO-WELCOME10'; api.applyCoupon();
  assert.deepEqual(J(api.state().appliedCoupon), { kind: 'percent', value: 10 });
  assert.doesNotMatch(els.q_couponMsg.textContent, /No such coupon/);
});
t('B6: a coupon switched off later still prices as saved; a NEW unknown code is refused', async () => {
  const { api, els } = couponHarness({ coupons: [], pricing: { couponCode: 'OLD5', coupon: { kind: 'flat', value: 5000 } } });
  await api.loadCoupons();
  els.q_coupon.value = 'old5'; api.applyCoupon();
  assert.deepEqual(J(api.state().appliedCoupon), { kind: 'flat', value: 5000 });
  assert.match(els.q_couponMsg.textContent, /no longer active/);
  els.q_coupon.value = 'NOPE'; api.applyCoupon();
  assert.equal(api.state().appliedCoupon, null); assert.equal(els.q_couponMsg.textContent, 'No such coupon code.');
});
t('B6 review: a switched-off coupon is re-saved EXACTLY as stored (tg_quote_money_guard re-checks a changed code/object)', async () => {
  const sc = { kind: 'percent', value: 10, code: 'demo-welcome10' };
  const { api, els } = couponHarness({ coupons: [], pricing: { couponCode: 'demo-welcome10', coupon: sc } });
  await api.loadCoupons();
  els.q_coupon.value = 'DEMO-WELCOME10'; api.applyCoupon();
  assert.deepEqual(J(api.state().appliedCoupon), sc, 'stored coupon object unchanged (extra keys kept)');
  assert.equal(api.state().appliedCouponCode, 'demo-welcome10', 'stored spelling kept - an upper-cased code would be "changed" and refused as inactive');
});
t('B20 review: a step-1 save clears a step 7 / 8 error it painted; hints + badge know a recorded advance', () => {
  assert.match(FLOW, /\["layout","quote"\]\.forEach\(k=>\{ if\(badgeSt\[k\]==="invalid"\) paintBadge\(k,"idle"\); \}\);\n\s*saved\("client"\);/);
  assert.match(FLOW, /BPStore\.quoteStatus\(ev,\{advance:PAID_SUM>0\}\)\.key/);
  assert.match(FLOW, /PAID_SUM=paid\.reduce[^\n]*try\{ paintStatusBadge\(\); \}catch\(_\)\{ \}/);
  assert.match(read('public/invite-site-share.js'), /el\("div", "ish-log-h", "Send history"\); logH\.hidden = true;/);
});
t('B6: loadAll loads the coupons BEFORE seedQuote; the stored code is upper-case', () => {
  const la = between(FLOW, '  async function loadAll(){', '    stampNewQuoteTax();');
  assert.match(la, /const couponsP=loadCoupons\(\);/);
  assert.ok(la.indexOf('await couponsP;') >= 0 && la.indexOf('await couponsP;') < la.indexOf('seedQuote();'), 'coupons awaited before seeding');
  assert.match(FLOW, /couponCode:appliedCoupon\?appliedCouponCode:normCoupon\(/);
  assert.match(FLOW, /\$\("#q_coupon"\)\.value=normCoupon\(pr\.couponCode\); applyCoupon\(\);/);
  assert.doesNotMatch(between(FLOW, '  function wire(){', '  function openLogin(){'), /\n\s*loadCoupons\(\);/);
});

/* ------------------------------------------------------------------ B7 capacity "reduce" */
t('B7: reduce saves step 1 FIRST (awaited), then records the decision, then refreshes the lock base', () => {
  const red = between(CAP, 'if (c === "reduce") {', 'if (c === "proceed") {');
  const iSet = red.indexOf('setField("c_guests", n);'), iSave = red.indexOf('await hostSaveClient()'), iRec = red.indexOf('await record(');
  assert.ok(iSet >= 0 && iSet < iSave && iSave < iRec, 'order: field -> save step 1 -> decision');
  assert.match(red, /if \(!\(await hostSaveClient\(\)\)\) \{ fail\(/);
  assert.match(CAP, /var d = await S\.quotes\.setCapacityDecision\(qid, payload\); q\.capacityDecision = d \|\| payload; await hostRelock\(\); return true;/);
  assert.match(FLOW, /window\.HelmFlowHost=\{ saveClientNow:\(\)=>\(AS&&AS\.has\("client"\)\)\?AS\.now\("client"\):Promise\.resolve\(true\), relock \};/);
});
t('B7: host hooks run in order and a failed step-1 save is reported (no decision recorded)', async () => {
  const log = [];
  const mx = { window: {} }; mx.globalThis = mx; vm.createContext(mx); vm.runInContext(CAP, mx);
  const C = mx.window.HelmCapacity;
  assert.equal(await C.hostSaveClient(), true);   // not the flow page: nothing to wait for
  mx.window.HelmFlowHost = { saveClientNow: async () => { log.push('save'); return true; }, relock: async () => { log.push('relock'); } };
  assert.equal(await C.hostSaveClient(), true); await C.hostRelock();
  assert.deepEqual(log, ['save', 'relock']);
  mx.window.HelmFlowHost.saveClientNow = async () => false; assert.equal(await C.hostSaveClient(), false);
  mx.window.HelmFlowHost.saveClientNow = async () => { throw new Error('x'); }; assert.equal(await C.hostSaveClient(), false);
});

/* ------------------------------------------------------------------ B19 one status label */
t('B19: the flow header badge uses BPStore.quoteStatus (no raw status text left)', () => {
  assert.match(FLOW, /function paintStatusBadge\(opts\)\{[\s\S]*?BPStore\.quoteStatus\(ev,Object\.assign\(\{advance:PAID_SUM>0\},opts\|\|\{\}\)\)/);
  assert.doesNotMatch(FLOW, /\$\("#statusBadge"\)\.textContent=/);
  assert.match(FLOW, /paintBookingBadge\(1\); paintStatusBadge\(\{advance:true\}\);/);
});

/* ------------------------------------------------------------------ store-api sandbox */
const SRC = read('public/store-api.js');
function memStore() { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; }
function storeApi() {
  const doc = { readyState: 'complete', addEventListener() {}, removeEventListener() {}, currentScript: { src: 'https://www.helm.events/store-api.js?v=1' },
    createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, addEventListener() {}, querySelector: () => null, remove() {} }),
    head: { appendChild() {} }, body: { appendChild() {}, removeChild() {}, children: [] },
    documentElement: { setAttribute() {}, getAttribute() { return 'light'; }, classList: { contains: () => false, add() {}, remove() {} } },
    querySelector: () => null, querySelectorAll: () => [], getElementById: () => null };
  const win = { localStorage: memStore(), sessionStorage: memStore(),
    location: { pathname: '/flow', search: '', hash: '', origin: 'http://localhost', href: '', hostname: 'localhost', replace() {}, reload() {} },
    document: doc, navigator: { onLine: true }, fetch: async () => ({ ok: false, status: 503, json: async () => ({}) }),
    addEventListener() {}, removeEventListener() {}, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    atob: (b) => Buffer.from(b, 'base64').toString('binary'), console: { log() {}, info() {}, warn() {}, error() {} } };
  win.window = win; win.globalThis = win; vm.createContext(win);
  vm.runInContext(read('public/country-profile.js'), win); vm.runInContext(SRC, win, { filename: 'store-api.js' });
  return win.BPStore;
}
const S = storeApi();
t('B19: confirmed + sent reads "Sent · awaiting client approval" (the label the flow badge now shows)', () => {
  assert.equal(S.quoteStatus({ status: 'confirmed', approvalStatus: 'sent' }).label, 'Sent · awaiting client approval');
  assert.equal(S.quoteStatus({ status: 'confirmed', approvalStatus: 'sent' }, { advance: true }).label, 'Confirmed · advance paid');
});
t('B28: GST is rounded once and split from it - CGST + SGST = GST, no half rupees', () => {
  assert.deepEqual(J(S.tax.halves(79443)), [39722, 39721]);
  assert.deepEqual(J(S.tax.halves(79442.6)), [39722, 39721]);
  assert.deepEqual(J(S.tax.halves(0)), [0, 0]);
  const rows = S.tax.rows({ totalGst: 79443 }, { placeOfSupply: 'intra' }, S.tax.resolve({}));
  assert.equal(rows.length, 2); assert.deepEqual(J(rows.map((r) => r.amount)), [39722, 39721]);   // was 39,721.5 + 39,721.5
  assert.match(read('public/approve.html'), /BPStore\.tax\.halves\(\(\+c\.cgst\|\|0\)\+\(\+c\.sgst\|\|0\)\)/);
  assert.match(read('public/proposal-view.html'), /BPStore\.tax\.halves\(num\(c\.cgst\)\+num\(c\.sgst\)\)/);
  assert.match(read('public/booklet.js'), /const g2 = Math\.round\(\(cgst \|\| 0\) \+ \(sgst \|\| 0\)\), c2 = Math\.round\(g2 \/ 2\);/);
});

/* ------------------------------------------------------------------ B20 hall size on step 7, once */
t('B20: an autosave refused for another step paints THAT step and clears its own badge', async () => {
  const AS = require('../public/flow-autosave.js');
  const badges = []; let res = { invalid: 'Hall length can\'t be negative.', section: 'layout' };
  const a = AS.create({ delay: 0, setTimeout: (f) => { f(); return 1; }, clearTimeout() {}, save: { client: async () => res }, badge: (s, st, m) => badges.push([s, st, m || ''].join('|')) });
  assert.equal(await a.now('client'), false);
  assert.deepEqual(badges, ['client|saving|', 'layout|invalid|Hall length can\'t be negative.', 'client|idle|']);
  assert.equal(a.hasFailed(), true);
  badges.length = 0; res = undefined;
  assert.equal(await a.now('client'), true);
  assert.deepEqual(badges, ['client|saving|', 'layout|idle|', 'client|saved|']);   // fixed -> step 7 error goes away
  badges.length = 0; res = { invalid: 'Enter the client name.' };
  await a.now('client'); assert.deepEqual(badges, ['client|saving|', 'client|invalid|Enter the client name.']);
});
t('B20: step-1 problems are tagged with their step; the toast names it and is not stacked twice', () => {
  assert.match(FLOW, /out\.push\(\{id:k,msg:res\.errors\[k\],sec\}\)/);
  assert.match(FLOW, /out\.push\(\{id:"q_chairs",msg:cr\.error,sec:"quote"\}\)/);
  assert.match(FLOW, /if\(quiet\) return sec==="client" \? \{ invalid:e0\.msg \} : \{ invalid:e0\.msg, section:sec \};/);
  assert.match(FLOW, /toastOnce\("Step "\+\(STEP_NO\[sec\]\|\|1\)\+" not saved: "\+e0\.msg/);
  assert.doesNotMatch(FLOW, /BPUI\.toast\("Step 1 not saved: "/);
  assert.match(FLOW, /if\(badgeSt\[k\]==="invalid"\) return;/);   // updateProgress keeps the step-7 error
  // toastOnce: same message within 4 s shows once
  const fn = new Function('BPUI', between(FLOW, '  let lastToast=', '  const GUESTS_MAX') + '; return toastOnce;');
  const shown = []; const once = fn({ toast: (m) => shown.push(m) });
  once('Step 7 not saved: x'); once('Step 7 not saved: x'); once('Step 1 not saved: y');
  assert.deepEqual(shown, ['Step 7 not saved: x', 'Step 1 not saved: y']);
});

/* ------------------------------------------------------------------ B21 WhatsApp test mode */
function fakeDom() {
  const mk = (tag) => { const n = { tagName: tag, children: [], attrs: {}, hidden: false, disabled: false, textContent: '', className: '', listeners: {},
    appendChild(c) { this.children.push(c); return c; }, setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; },
    addEventListener(e, f) { (this.listeners[e] = this.listeners[e] || []).push(f); }, focus() {} }; return n; };
  return { createElement: mk };
}
function waMount(opts, sub) {
  const ctx = { window: {}, document: fakeDom() };
  ctx.window.BPStore = { waNumber: (s) => String(s).replace(/\D/g, '').replace(/^(\d{10})$/, '91$1'),
    approval: { waState: async () => null, waSend: async () => ({ simulated: true, status: 'simulated', trial: true }) }, subscription: sub };
  vm.runInNewContext(read('public/wa-proposal.js'), ctx);
  const host = ctx.document.createElement('div');
  ctx.window.HelmWaProposal.mount(host, Object.assign({ quoteId: 'q1', getPhone: () => '9876543210' }, opts));
  const box = host.children[0], find = (id) => box.children.find((c) => c.id === id), btn = find('wapSend'), note = box.children.find((c) => c.className === 'wap-trial');
  return { W: ctx.window.HelmWaProposal, btn, note };
}
const tick = () => new Promise((r) => setTimeout(r, 5));
t('B21: in the free trial the button says "(test mode)" and the test-mode line shows (same as the invitation box)', async () => {
  const { btn, note, W } = waMount({ trial: Promise.resolve(true) });
  await tick();
  assert.equal(btn.textContent, 'Send on WhatsApp (test mode)'); assert.equal(note.hidden, false);
  assert.equal(note.textContent, W.TRIAL_NOTE);
  assert.match(read('public/invite-site-share.js'), new RegExp('TRIAL_NOTE = "' + W.TRIAL_NOTE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"'));
});
t('B21: trial read from my_trial_status when the page passes nothing; a paid studio shows no label', async () => {
  const a = waMount({}, { trial: async () => ({ status: 'trial' }) }); await tick();
  assert.equal(a.btn.textContent, 'Send on WhatsApp (test mode)');
  const b = waMount({}, { trial: async () => ({ status: 'active' }) }); await tick();
  assert.equal(b.btn.textContent, 'Send on WhatsApp'); assert.equal(b.note.hidden, true);
  assert.equal(b.W.btnText('proposal_reminder', true), 'Send reminder on WhatsApp (test mode)');
});

/* ------------------------------------------------------------------ B28 copy / consistency */
t('B28: requirement list uses the picker words; the box is emptied before the re-read', () => {
  assert.match(FLOW, /const REQ_PRI=\{ mandatory:"Must-have", optional:"Optional", nice:"Nice-to-have" \};/);
  assert.match(FLOW, /<span class="pill">\$\{esc\(REQ_PRI\[r\.priority\]\|\|r\.priority\|\|""\)\}<\/span>/);
  const add = between(FLOW, 'const addReq=()=>{', '$("#rq_add").addEventListener');
  assert.ok(add.indexOf('$("#rq_title").value=""') < add.indexOf('await renderReqs()'));
  assert.match(add, /FV\.setMsg\(document,"rq_title",""\)/);
});
t('B28: discount error on the save line clears once fixed; live next-step hints; en-IN receipt dates', () => {
  assert.match(FLOW, /if\(!m && qm && qm\.dataset\.disc==="1"\)\{ qm\.textContent=""; delete qm\.dataset\.disc; \}/);
  assert.match(FLOW, /function nextHintText\(k, key\)/); assert.match(FLOW, /paintLiveHints\(\);/);
  assert.match(FLOW, /BPStore\.fmtStudioDate\(p\.paid_at,\{style:"long"\}\)/);
  const nh = new Function(between(FLOW, '  function nextHintText(k, key){', '  function paintLiveHints(){') + '; return nextHintText;')();
  assert.match(nh('quote', 'sent'), /waiting for the client/); assert.doesNotMatch(nh('quote', 'sent'), /Send for approval/);
  assert.match(nh('quote', 'locked'), /Send for approval/); assert.doesNotMatch(nh('layout', 'sent'), /Send for approval/);
});
t('B28: flow quote name follows the same displayName rule as the list', () => {
  assert.match(FLOW, /const shown=H\?\(auto\?\(H\.displayName\(liveParts\(\)\)\|\|autoName\(\)\):ev\.title\)/);
  const EN = require('../public/event-name.js');
  const live = { code: '10182026-01', title: 'WED_HYD_1300_19AUG26-2', eventType: 'wedding', eventDate: '2026-08-19', client: { city: 'Hyderabad', guests: 1300 } };
  assert.equal(EN.displayName(live), 'WED_HYD_1300_19AUG26-2');                       // same as the list
  assert.equal(EN.displayName(Object.assign({}, live, { client: { city: 'Hyderabad', guests: 600 } })), 'WED_HYD_600_19AUG26');   // guests change -> new name
});
t('B28: workspace - sent quote no longer says "Send quote"; layout card counts objects; stage 5 is "Confirmed"', () => {
  assert.match(EV, /qsKey==="sent"\)\{ t="Follow up on the quote";/);
  assert.match(EV, /layoutSummary=\{ objects:it\.length \}/);
  assert.match(EV, /\$\{layoutSummary\.objects\} object\$\{layoutSummary\.objects===1\?"":"s"\} on the floor plan/);
  assert.match(EV, /const stageLabel=\(s\)=> s\.label;/); assert.doesNotMatch(EV, /\? "Booked" :/);
});
t('B28: booklet share - studio-zone dates, at least one version ticked; send log heading; overlay over the header; hidden budget amounts', () => {
  const B = read('public/booklet-share.js');
  assert.match(B, /B\.fmtStudioDate\(d, \{ style: "long" \}\)/);
  assert.match(B, /if \(versions\.length && !ids\.length\) \{ msg\.textContent = "Tick at least one quote version to show the client\."/);
  assert.match(read('public/invite-site-share.js'), /el\("div", "ish-log-h", "Send history"\)/);
  assert.match(read('public/capacity-shortage.css'), /^\.capd-ov\{position:fixed;inset:0;z-index:1100;/m);
  assert.match(read('public/shell-b-privacy.css'), /html\.hb-priv-on :is\(input\.hbp-mi, input\[data-pl-est\], input\[data-pl-quoted\], input\[data-pl-act\]\):not\(:focus\)/);
  assert.match(read('public/budget.html'), /<input id="c_est" class="hbp-mi" type="number"/);
});

let n = 0;
for (const [name, fn] of tests) { await fn(); n++; console.log('  ✓ ' + name); }
console.log(`qa-quote-flow: ${n} passed`);
