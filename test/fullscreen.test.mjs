/* fullscreen.test.mjs — fullscreen for 2D / 3D / walkthrough (public/fullscreen.js):
 * F toggles / Esc exits (never while typing or with modifiers), native API via vendor shim, CSS pseudo-fullscreen
 * fallback when the API is missing (iOS Safari), chrome hidden + floating controls, relayout, wiring, CSP. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const rd = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const src = rd('public/fullscreen.js');
const cx = {}; cx.globalThis = cx; vm.createContext(cx); vm.runInContext(src, cx);
const FS = cx.HelmFullscreen;
// keys
assert.equal(FS.fsKey({ key: 'f' }), 'toggle'); assert.equal(FS.fsKey({ key: 'F' }), 'toggle');
assert.equal(FS.fsKey({ key: 'Escape' }), 'exit');
assert.equal(FS.fsKey({ key: 'f' }, true), null, 'typing in a field');
assert.equal(FS.fsKey({ key: 'f', metaKey: true }), null); assert.equal(FS.fsKey({ key: 'f', ctrlKey: true }), null);
assert.equal(FS.fsKey({ key: 'g' }), null);
// vendor shim: standard, webkit, none
{ let called = 0; const el = { requestFullscreen() { called++; return Promise.resolve(); } };
  const a = FS.api({ documentElement: el, fullscreenEnabled: true, fullscreenElement: el, exitFullscreen() {} });
  assert.equal(a.native, true); await a.request(el); assert.equal(called, 1); assert.equal(a.element(), el); }
{ let called = 0; const el = { webkitRequestFullscreen() { called++; } };
  const a = FS.api({ documentElement: el, webkitFullscreenEnabled: true, webkitFullscreenElement: null });
  assert.equal(a.native, true); await a.request(el); assert.equal(called, 1); }
{ const a = FS.api({ documentElement: {} });   // iPhone Safari: no element fullscreen → pseudo
  assert.equal(a.native, false); await assert.rejects(a.request({})); }

// ---- DOM behaviour with a tiny fake document (pseudo fallback + native) ----
function fakeDom(native) {
  const listeners = {}, classes = (o) => { const s = new Set(); o.classList = { add: (c) => s.add(c), remove: (c) => s.delete(c), contains: (c) => s.has(c), toggle: (c, on) => { if (on === undefined) on = !s.has(c); on ? s.add(c) : s.delete(c); return on; } }; return o; };
  const mkEl = (tag) => { const e = classes({ tagName: String(tag).toUpperCase(), attrs: {}, children: [], hidden: false, listeners: {},
    setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return this.attrs[k]; }, append(...c) { this.children.push(...c); },
    after(x) { this.afterEl = x; }, addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); },
    click() { (this.listeners.click || []).forEach((f) => f({ currentTarget: this })); }, focus() {}, closest() { return fieldEl; } }); return e; };
  const vp = mkEl('section'), body = mkEl('body'), seg = mkEl('div'), fieldEl = mkEl('div');
  let fsEl = null;
  if (native) vp.requestFullscreen = () => { fsEl = vp; (listeners.fullscreenchange || []).forEach((f) => f()); return Promise.resolve(); };
  const doc = { readyState: 'complete', body, documentElement: native ? { requestFullscreen() {} } : {}, fullscreenEnabled: native,
    get fullscreenElement() { return fsEl; }, exitFullscreen() { fsEl = null; (listeners.fullscreenchange || []).forEach((f) => f()); return Promise.resolve(); },
    createElement: mkEl, addEventListener(t, f) { (listeners[t] = listeners[t] || []).push(f); },
    querySelector(q) { if (q === '.viewport') return vp; return null; }, querySelectorAll() { return []; },
    getElementById(id) { return id === 'viewSeg' ? seg : null; }, contains() { return true; }, activeElement: null };
  const win = { document: doc, requestAnimationFrame: (f) => f(), dispatchEvent() { win.resized = (win.resized || 0) + 1; }, Event: function (t) { this.type = t; } };
  win.globalThis = win;
  const c = vm.createContext(win); vm.runInContext(src.replace("typeof window !== 'undefined' ? window : globalThis", 'globalThis'), c);
  return { win, doc, vp, body, fieldEl, listeners, key: (k, extra) => (listeners.keydown || []).forEach((f) => f(Object.assign({ key: k, target: { tagName: 'BODY' }, preventDefault() {} }, extra || {}))) };
}
for (const native of [false, true]) {
  const d = fakeDom(native), ui = d.win.HelmFullscreen._ui;
  assert.ok(d.fieldEl.afterEl && d.fieldEl.afterEl.attrs.id === 'fsBtn', 'header button after the View switch');
  const bar = d.vp.children.find((c) => c.attrs.id === 'fsBar'); assert.ok(bar && bar.hidden, 'floating bar hidden until fullscreen');
  assert.ok(d.vp.children.some((c) => c.attrs.id === 'fsFab'), 'floating fullscreen button on the canvas');
  d.key('f'); await new Promise((r) => setTimeout(r, 0));
  assert.equal(ui.isOn(), true, 'F enters (' + (native ? 'native' : 'pseudo') + ')');
  assert.ok(d.body.classList.contains('fs-on'), 'chrome hidden');
  assert.equal(d.vp.classList.contains('fs-pseudo'), !native, 'pseudo class only without the API');
  assert.equal(bar.hidden, false, 'floating controls shown'); assert.ok(d.win.resized > 0, 'renderers resized');
  const labels = bar.children.map((b) => b.textContent); assert.deepEqual(labels, ['2D', '3D', '⌾ Walk', '✕ Exit']);
  d.key('f', { target: { tagName: 'INPUT' } }); assert.equal(ui.isOn(), true, 'typing F does nothing');
  if (native) { d.doc.exitFullscreen(); } else d.key('Escape');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(ui.isOn(), false, 'Esc exits'); assert.ok(!d.body.classList.contains('fs-on')); assert.ok(bar.hidden);
}
// CSS + wiring
const css = rd('public/layout-wizard.css');
assert.match(css, /\.viewport\.fs-pseudo\{position:fixed;inset:0;z-index:55;/);
assert.match(css, /body\.fs-on header,body\.fs-on #leftPanel,body\.fs-on #rightPanel\{visibility:hidden\}/);
assert.match(css, /\.viewport:fullscreen/);
assert.match(css, /100dvh/, 'iOS dynamic viewport height');
const bh = rd('public/builder.html');
assert.match(bh, /<script src="fullscreen\.js\?v=5"><\/script>/);
assert.ok(!/fullscreen\.js|layout-wizard/.test(rd('public/capture.html')), 'not in the headless capture host');
assert.ok(!/\.style\.|innerHTML|\beval\(/.test(src), 'CSP-safe');
console.log('  ✓ fullscreen: keys, vendor shim, native + iOS pseudo fallback, chrome hidden, floating controls, Esc, wiring');
