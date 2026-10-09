// R8b: zero manual picture-taking. The share checklist renders missing / stale 2D + 3D pictures in a
// hidden same-origin capture host (capture.html, generated from builder.html) and trusts only
// messages from that iframe, same origin, same quote. capture.html is the ONLY framable app page.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { captureHtml } from '../scripts/gen-capture-host.mjs';
import { createRequire } from 'node:module';
const { frameAncestorsProblem } = createRequire(import.meta.url)('../scripts/csp-hashes.cjs');

const R = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('  ok  ' + name); };
const tick = async (k = 10) => { for (let i = 0; i < k; i++) await new Promise((r) => setImmediate(r)); };
const Q = '11111111-2222-4333-8444-555555555555';

class N {
  constructor(tag) { this.tagName = String(tag).toUpperCase(); this.children = []; this.parentNode = null; this.attrs = {}; this._t = ''; this.hidden = false; this.listeners = {}; this.checked = false; this.className = ''; }
  get firstChild() { return this.children[0] || null; }
  appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.children.push(c); return c; }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; return c; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  set textContent(v) { this.children = []; this._t = String(v); }
  get textContent() { return this._t + this.children.map((c) => c.textContent).join(''); }
  addEventListener(e, f) { (this.listeners[e] = this.listeners[e] || []).push(f); }
  all() { const o = []; const w = (x) => x.children.forEach((c) => { o.push(c); w(c); }); w(this); return o; }
}
function load(extra) {
  const d = { createElement: (t) => new N(t), createTextNode: (x) => { const k = new N('#text'); k._t = String(x); return k; }, querySelector: () => null, readyState: 'complete' };
  d.body = new N('body');
  const cx = { console, URLSearchParams, setTimeout, clearTimeout, document: d, location: { search: '', origin: 'https://www.helm.events' }, addEventListener() {}, removeEventListener() {}, ...extra };
  cx.window = cx; cx.globalThis = cx; vm.createContext(cx); vm.runInContext(R('public/share-checklist.js'), cx);
  return cx;
}

await t('message protocol: only same origin + our iframe + our quote + known type', () => {
  const S = load().HelmShareChecklist, src = {};
  const o = { origin: 'https://www.helm.events', source: src, quoteId: Q };
  const ok = { origin: o.origin, source: src, data: { type: 'helm-capture-done', quoteId: Q, ok: true } };
  assert.equal(S.acceptCaptureMessage(ok, o).ok, true);
  assert.equal(S.acceptCaptureMessage({ ...ok, origin: 'https://evil.example' }, o), null, 'other origin');
  assert.equal(S.acceptCaptureMessage({ ...ok, source: {} }, o), null, 'other window');
  assert.equal(S.acceptCaptureMessage({ ...ok, data: { ...ok.data, quoteId: 'other' } }, o), null, 'other quote');
  assert.equal(S.acceptCaptureMessage({ ...ok, data: { ...ok.data, type: 'x' } }, o), null, 'unknown type');
  assert.equal(S.acceptCaptureMessage({ ...ok, data: 'helm-capture-done' }, o), null, 'non-object');
  assert.equal(S.acceptCaptureMessage(ok, { ...o, quoteId: '' }), null, 'no expected quote');
  assert.equal(S.captureUrl(Q), '/capture.html?quote=' + Q);
});

await t('autoCapture: hidden iframe, resolves on the right message, ignores spoofs, 60s timeout', async () => {
  const listeners = [];
  const cx = load({ addEventListener: (e, f) => listeners.push(f), removeEventListener: (e, f) => { const i = listeners.indexOf(f); if (i >= 0) listeners.splice(i, 1); } });
  const S = cx.HelmShareChecklist; const steps = [];
  const p = S.autoCapture(Q, { onProgress: (s) => steps.push(s) });
  const fr = cx.document.body.children[0]; fr.contentWindow = {};
  assert.equal(fr.tagName, 'IFRAME'); assert.equal(fr.getAttribute('src'), '/capture.html?quote=' + Q);
  assert.match(fr.getAttribute('style'), /left:-12000px/);
  const send = (ev) => listeners.slice().forEach((f) => f(ev));
  send({ origin: 'https://evil.example', source: fr.contentWindow, data: { type: 'helm-capture-done', quoteId: Q, ok: true } });
  send({ origin: 'https://www.helm.events', source: fr.contentWindow, data: { type: 'helm-capture-progress', quoteId: Q, step: '2d' } });
  send({ origin: 'https://www.helm.events', source: fr.contentWindow, data: { type: 'helm-capture-done', quoteId: Q, ok: true, results: { '2d_labels': true } } });
  const r = await p;
  assert.equal(r.ok, true); assert.deepEqual(steps, ['2d']);
  assert.equal(cx.document.body.children.length, 0, 'iframe removed'); assert.equal(listeners.length, 0, 'listener removed');
  await assert.rejects(S.autoCapture(Q, { timeoutMs: 20 }), /longer than 60 seconds/);
  assert.equal(S.CAPTURE_TIMEOUT_MS, 60000);
});

async function share(info, versions, cap, sections) {
  const calls = [];
  const cx = load({ BPStore: { plan: { get: async () => null }, booklet: { imageInfo: async () => info(), staffImage: async () => null, setImageVariants: async () => {} }, quotes: { versions: async () => versions } } });
  const host = new N('div');
  const ck = cx.HelmShareChecklist.mount(host, { quoteId: Q, cur: { sections }, autoCapture: async (q, o) => { calls.push(q); o.onProgress('2d'); o.onProgress('3d'); return cap(); } });
  await tick();
  return { ck, host, calls };
}
const FRESH = '2026-10-09T10:00:00Z', OLD = '2026-10-01T10:00:00Z', V = [{ createdAt: '2026-10-05T00:00:00Z' }];
const all = (ts) => ({ '2d': { labels: ts, plain: ts }, '3d': { labels: ts, plain: ts } });

await t('share: ticked + missing pictures → auto-capture, with progress, then share proceeds', async () => {
  let info = {};
  const s = await share(() => info, V, () => { info = all(FRESH); return { ok: true }; }, { layout2d: true, layout3d: true });
  await s.ck.uploadSnapshots();
  assert.deepEqual(s.calls, [Q]);
  assert.match(s.host.textContent, /Pictures ready — 2D ✓ 3D ✓/);
  assert.equal(s.ck.sections().layout2d, true);
});
await t('share: stale pictures (older than the latest layout) → regenerated automatically', async () => {
  let info = all(OLD);
  const s = await share(() => info, V, () => { info = all(FRESH); return { ok: true }; }, { layout2d: true });
  await s.ck.uploadSnapshots(); assert.equal(s.calls.length, 1);
});
await t('share: fresh pictures or no 2D/3D ticked → no capture', async () => {
  let s = await share(() => all(FRESH), V, () => ({ ok: true }), { layout2d: true, layout3d: true });
  await s.ck.uploadSnapshots(); assert.equal(s.calls.length, 0);
  s = await share(() => ({}), V, () => ({ ok: true }), { layout2d: false, layout3d: false, terms: true });
  await s.ck.uploadSnapshots(); assert.equal(s.calls.length, 0);
});
await t('share: empty layout → pictures skipped with a note (sections dropped), never blocked', async () => {
  const s = await share(() => ({}), V, () => ({ ok: true, empty: true }), { layout2d: true, layout3d: true });
  await s.ck.uploadSnapshots();
  assert.match(s.host.textContent, /no items yet — the 2D \/ 3D pictures are skipped/);
  assert.equal(s.ck.sections().layout2d, false); assert.equal(s.ck.sections().layout3d, false);
});
await t('share: capture failure / timeout → clear error with retry; still-missing after capture → error', async () => {
  let s = await share(() => ({}), V, () => { throw new Error('Preparing the pictures took longer than 60 seconds.'); }, { layout2d: true });
  await assert.rejects(s.ck.uploadSnapshots(), /60 seconds[\s\S]*retry/);
  s = await share(() => ({}), V, () => ({ ok: false }), { layout2d: true });
  await assert.rejects(s.ck.uploadSnapshots(), /couldn’t be prepared \(2D with labels, 2D without labels\)[\s\S]*retry/);
});

await t('builder capture-host mode: marker meta, same-origin postMessage, no draft/preset/auto side effects', () => {
  const b = R('public/builder.js');
  assert.match(b, /const CAPTURE_HOST = !!document\.querySelector\('meta\[name="helm-capture"\]'\) && window\.parent!==window;/);
  assert.match(b, /window\.parent\.postMessage\(captureHostMessage\(qid, m\), location\.origin\)/);
  assert.match(b, /type:'helm-capture-done', ok:true, empty:true/);
  assert.match(b, /captureProgressHook\('2d'\)[\s\S]{0,200}say\('Capturing 3D…'\)/);
  assert.match(b, /if\(!CAPTURE_HOST\)\{ await offerDraftRestore\(\);/);
  assert.match(b, /TEMPLATES\[presetKey\] && !CAPTURE_HOST/);
  assert.match(b, /\$\('#clientImgBtn'\)\.addEventListener/, 'manual "Update client images" kept');
});

await t('capture.html is generated from builder.html (same drawing code), marked, no tour', () => {
  const b = R('public/builder.html'), c = R('public/capture.html');
  assert.equal(c, captureHtml(b), 'run: node scripts/gen-capture-host.mjs');
  assert.match(c, /<meta name="helm-capture" content="1">/); assert.ok(!/helm-capture/.test(b));
  assert.ok(!/tour\.js/.test(c)); assert.match(c, /builder\.js\?v=27/);
});

await t('CSP: frame-ancestors \'self\' only on the capture route (+ invite); builder stays none', () => {
  const v = JSON.parse(R('vercel.json'));
  const last = (p) => { let csp = null, xfo = null; for (const r of v.headers) { if (r.has) continue; if (new RegExp('^' + r.source + '$').test(p)) for (const h of r.headers) { if (h.key === 'Content-Security-Policy') csp = h.value; if (h.key === 'X-Frame-Options') xfo = h.value; } } return { csp, xfo }; };
  for (const p of ['/capture', '/capture.html']) { const h = last(p); assert.match(h.csp, /frame-ancestors 'self'/); assert.equal(h.xfo, 'SAMEORIGIN'); assert.match(h.csp, /cdnjs|jsdelivr/, 'builder 3D sources'); }
  for (const p of ['/builder', '/builder.html', '/flow', '/event.html', '/client', '/dashboard']) { const h = last(p); assert.match(h.csp, /frame-ancestors 'none'/, p); assert.equal(h.xfo, 'DENY', p); }
  const hd = R('public/_headers');
  assert.match(hd, /\n\/capture\.html\n  ! X-Frame-Options\n  X-Frame-Options: SAMEORIGIN\n  ! Content-Security-Policy\n  Content-Security-Policy: [^\n]*frame-ancestors 'self'/);
  assert.match(hd, /\n\/builder\.html\n  ! Content-Security-Policy\n  Content-Security-Policy: [^\n]*frame-ancestors 'none'/);
  assert.equal(frameAncestorsProblem("default-src 'self'; frame-ancestors 'self'", '/builder\\.html') !== '', true, 'generator rejects self on builder');
  assert.equal(frameAncestorsProblem("frame-ancestors 'self'", '/(capture|capture\\.html)'), '');
  assert.equal(frameAncestorsProblem("frame-ancestors *", '/(capture|capture\\.html)') !== '', true);
  const srv = R('server.js');
  assert.match(srv, /capture: buildCsp\(\{ 'script-src': SCRIPT_SRC_BUILDER\.join\(' '\), 'frame-ancestors': "'self'" \}\)/);
});
/* ---- R9 edge cases ---- */
const fail = (msg, code) => () => { throw Object.assign(new Error(msg), { code }); };
await t('R9: two share clicks → ONE iframe (second joins the running capture); next one after it finishes is new', async () => {
  const listeners = [];
  const cx = load({ addEventListener: (e, f) => listeners.push(f), removeEventListener: (e, f) => { const i = listeners.indexOf(f); if (i >= 0) listeners.splice(i, 1); } });
  const S = cx.HelmShareChecklist;
  const a = S.autoCapture(Q), b = S.autoCapture(Q);
  assert.equal(a, b); assert.equal(cx.document.body.children.length, 1, 'no duplicate iframe');
  const fr = cx.document.body.children[0]; fr.contentWindow = {};
  // a message for ANOTHER quote (e.g. client.html listing several events) is ignored
  listeners.slice().forEach((f) => f({ origin: 'https://www.helm.events', source: fr.contentWindow, data: { type: 'helm-capture-done', quoteId: '99999999-2222-4333-8444-555555555555', ok: true } }));
  assert.equal(cx.document.body.children.length, 1);
  listeners.slice().forEach((f) => f({ origin: 'https://www.helm.events', source: fr.contentWindow, data: { type: 'helm-capture-done', quoteId: Q, ok: false, code: 'frozen', error: 'closed' } }));
  await assert.rejects(a, (e) => e.code === 'frozen');
  await tick();
  const c = S.autoCapture(Q, { timeoutMs: 5 }); assert.notEqual(c, a); await assert.rejects(c, /longer/);
  assert.equal(cx.document.body.children.length, 0);
});
await t('R9: capture URL is root-absolute (pretty URLs like /studio/events/<id>)', () => {
  assert.equal(load().HelmShareChecklist.captureUrl(Q), '/capture.html?quote=' + Q);
});
await t('R9: closed / view-only event with stale (not missing) pictures → shares with the saved ones, no block', async () => {
  for (const code of ['frozen', 'readonly']) {
    const s = await share(() => all(OLD), V, fail('x', code), { layout2d: true, layout3d: true });
    await s.ck.uploadSnapshots();
    assert.match(s.host.textContent, /last saved pictures/); assert.equal(s.ck.sections().layout2d, true);
  }
});
await t('R9: closed / view-only / signed-out with MISSING pictures → specific clear message', async () => {
  let s = await share(() => ({}), V, fail('x', 'frozen'), { layout2d: true });
  await assert.rejects(s.ck.uploadSnapshots(), /closed, cancelled or archived[\s\S]*Untick/);
  s = await share(() => ({}), V, fail('x', 'readonly'), { layout3d: true });
  await assert.rejects(s.ck.uploadSnapshots(), /permission/);
  s = await share(() => ({}), V, fail('x', 'signin'), { layout2d: true });
  await assert.rejects(s.ck.uploadSnapshots(), /sign in again/);
});
await t('R9: WebGL unavailable → 2D saved, 3D-specific message', async () => {
  let info = {};
  const s = await share(() => info, V, () => { info = { '2d': { labels: FRESH, plain: FRESH } }; return { ok: true }; }, { layout2d: true, layout3d: true });
  await assert.rejects(s.ck.uploadSnapshots(), /3D pictures couldn’t be rendered[\s\S]*2D pictures were saved/);
});
await t('R9: only one style ticked → only that style is required', async () => {
  for (const st of ['labels', 'plain']) {
    const s = await share(() => ({ '2d': { [st]: FRESH } }), V, () => ({ ok: true }), { layout2d: true });
    for (const n of s.host.all()) if (n.attrs && n.attrs['data-style'] && n.attrs['data-style'] !== st) { n.checked = false; n.listeners.change.forEach((f) => f()); }
    await s.ck.uploadSnapshots(); assert.equal(s.calls.length, 0, st);
  }
});
await t('R9: builder capture host — frozen check, signed-out answers instead of redirecting, 4096px cap', () => {
  const b = R('public/builder.js');
  assert.match(b, /currentQuoteGuard\.frozen\)\{ post\(\{type:'helm-capture-done', ok:false, code:'frozen'/);
  assert.match(b, /code:'readonly'/);
  assert.match(b, /if\(CAPTURE_HOST\)\{ try\{ window\.parent\.postMessage\(\{type:'helm-capture-done'[^}]*code:'signin'[^\n]*location\.origin\); \}catch\(e\)\{\} return; \}\s*location\.replace\('\/login/);
  assert.match(b, /Math\.min\(4, o\.maxW\/W, 4096\/H\)/);
});
console.log('r8b-capture-host: ' + n + ' passed');
{ // R9: numbered template labels collapse into one legend entry
  const { readFileSync: rf } = await import('node:fs'); const vm2 = (await import('node:vm')).default;
  const cx = { window: {} }; cx.globalThis = cx; vm2.createContext(cx); vm2.runInContext(rf(new URL('../public/capture-frame.js', import.meta.url), 'utf8'), cx);
  const CF = cx.window.HelmCaptureFrame || cx.HelmCaptureFrame;
  const items = [];
  for (let i = 1; i <= 16; i++) items.push({ id: 't' + i, type: 'table', label: 'Table ' + i, x: i * 5, y: 10, width: 4, height: 4 });
  items.push({ id: 'v', type: 'table', label: 'VIP Table', x: 1, y: 30, width: 4, height: 4 }, { id: 'h', type: 'table', label: 'Head Table', x: 9, y: 30, width: 4, height: 4 }, { id: 'b', type: 'bar', label: 'Bar 1', x: 1, y: 50, width: 4, height: 4 }, { id: 'b2', type: 'bar', label: 'bar #2', x: 9, y: 50, width: 4, height: 4 });
  const r = CF.numberItems(items);
  const tbl = r.legend.find((l) => l.name === 'Table'); assert.equal(tbl.count, 16);
  assert.equal(new Set(items.slice(0, 16).map((it) => r.byId.get(it.id))).size, 1, 'all tables share one badge');
  assert.ok(r.legend.find((l) => l.name === 'VIP Table') && r.legend.find((l) => l.name === 'Head Table'), 'custom names kept');
  assert.equal(r.legend.find((l) => l.name === 'Bar').count, 2);
  assert.equal(r.legend.length, 4);
  console.log('  ok  R9: "Table 1..16" → one legend number ×16; custom names separate');
}
