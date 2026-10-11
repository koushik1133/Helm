/* fullscreen.js — distraction-free FULLSCREEN for the 2D plan, 3D view and the walkthrough.
 *
 * The canvas container (.viewport — it holds the 2D svg, the 3D stage and the walkthrough overlay) goes
 * fullscreen through the Fullscreen API (prefixed webkit too). Where the API is missing (iPhone Safari)
 * a CSS pseudo-fullscreen takes over: the viewport is pinned over the whole window. Either way the app
 * header, side panels and toolbars are hidden and a small floating bar keeps the key controls:
 * 2D / 3D toggle, walkthrough, exit. Zoom (+ − FIT) and the walkthrough's own prev/next stay visible.
 * F toggles, Esc exits (native fullscreen exits on Esc by itself). The 3D renderer and 2D rulers resize.
 *
 *   HelmFullscreen.fsKey(event, typing)  → 'toggle' | 'exit' | null   (pure, tested)
 *   HelmFullscreen.api(doc)              → { request(el), exit(), element(), native }  (vendor-prefix shim)
 */
(function (G) {
  'use strict';
  function fsKey(e, typing) {
    if (!e || typing || e.metaKey || e.ctrlKey || e.altKey) return null;
    if (e.key === 'f' || e.key === 'F') return 'toggle';
    if (e.key === 'Escape') return 'exit';
    return null;
  }
  function api(doc) {
    const de = doc.documentElement || {};
    const req = de.requestFullscreen ? 'requestFullscreen' : de.webkitRequestFullscreen ? 'webkitRequestFullscreen' : null;
    const native = !!(req && (doc.fullscreenEnabled || doc.webkitFullscreenEnabled));
    return {
      native,
      request(el) { const f = el[req]; if (!native || !f) return Promise.reject(new Error('unsupported')); try { return Promise.resolve(f.call(el)); } catch (err) { return Promise.reject(err); } },
      exit() { const f = doc.exitFullscreen || doc.webkitExitFullscreen; try { return Promise.resolve(f && f.call(doc)); } catch (err) { return Promise.resolve(); } },
      element() { return doc.fullscreenElement || doc.webkitFullscreenElement || null; },
    };
  }
  const API = { fsKey, api };
  G.HelmFullscreen = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (!G.document) return;

  const doc = G.document;
  const el = (tag, cls, text, attrs) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; if (attrs) Object.entries(attrs).forEach(([k, v]) => e.setAttribute(k, v)); return e; };
  let vp = null, pseudo = false, opener = null;
  const F = api(doc);
  const isOn = () => pseudo || (!!F.element() && F.element() === vp);

  // header button (beside the View switch) + a floating button on the canvas
  const bHead = el('button', 'tbtn fs-btn', '⛶ Fullscreen', { type: 'button', id: 'fsBtn', title: 'Fullscreen (F)', 'aria-pressed': 'false' });
  const bFab = el('button', 'fs-fab', '⛶', { type: 'button', id: 'fsFab', title: 'Fullscreen (F)', 'aria-label': 'Enter fullscreen' });
  // floating controls while fullscreen
  const bar = el('div', 'fs-bar', null, { role: 'toolbar', 'aria-label': 'Fullscreen controls', id: 'fsBar' });
  const b2 = el('button', 'fs-b', '2D', { type: 'button', 'data-v': '2d', 'aria-label': 'Show 2D plan' });
  const b3 = el('button', 'fs-b', '3D', { type: 'button', 'data-v': '3d', 'aria-label': 'Show 3D view' });
  const bW = el('button', 'fs-b', '⌾ Walk', { type: 'button', 'aria-label': 'Start the walkthrough', title: 'Guided walkthrough (← → to move, Esc to stop)' });
  const bX = el('button', 'fs-b fs-x', '✕ Exit', { type: 'button', id: 'fsExit', 'aria-label': 'Exit fullscreen (Esc)', title: 'Exit fullscreen (Esc)' });
  bar.append(b2, b3, bW, bX);

  function syncView() {
    const on3 = !!(G.__helm3D && G.__helm3D.isActive && G.__helm3D.isActive());
    b2.setAttribute('aria-pressed', String(!on3)); b3.setAttribute('aria-pressed', String(on3));
    b2.classList.toggle('on', !on3); b3.classList.toggle('on', on3);
  }
  function relayout() {
    // let the browser apply the new size, then resize the 3D renderer (window resize) and refit the 2D plan
    G.requestAnimationFrame(() => G.requestAnimationFrame(() => {
      try { G.dispatchEvent(new G.Event('resize')); } catch (_) {}
      try { if (typeof fitView === 'function') fitView(); } catch (_) {}   // eslint-disable-line no-undef
    }));
  }
  function apply(on) {
    doc.body.classList.toggle('fs-on', on);
    if (vp) vp.classList.toggle('fs-pseudo', on && pseudo);
    bHead.setAttribute('aria-pressed', String(on)); bHead.textContent = on ? '⛶ Exit fullscreen' : '⛶ Fullscreen';
    bFab.setAttribute('aria-label', on ? 'Exit fullscreen' : 'Enter fullscreen');
    bar.hidden = !on; syncView(); relayout();
    if (on) { try { bX.focus({ preventScroll: true }); } catch (_) {} }
    else if (opener && opener.focus && doc.contains(opener)) { try { opener.focus({ preventScroll: true }); } catch (_) {} }
  }
  function enter(e) {
    if (!vp || isOn()) return;
    opener = (e && e.currentTarget) || doc.activeElement;
    // close the mobile drawers first so nothing is left floating over the canvas
    try { doc.querySelectorAll('#leftPanel.open,#rightPanel.open').forEach((p) => p.classList.remove('open')); } catch (_) {}
    F.request(vp).then(() => { pseudo = false; }).catch(() => { pseudo = true; apply(true); });
  }
  function exit() {
    if (pseudo) { pseudo = false; apply(false); return; }
    if (F.element()) F.exit();
  }
  function toggle(e) { if (isOn()) exit(); else enter(e); }
  ['fullscreenchange', 'webkitfullscreenchange'].forEach((ev) => doc.addEventListener(ev, () => { if (!pseudo) apply(F.element() === vp && !!vp); }));

  bHead.addEventListener('click', toggle);
  bFab.addEventListener('click', toggle);
  bX.addEventListener('click', exit);
  [b2, b3].forEach((b) => b.addEventListener('click', () => {
    const t = doc.querySelector('#viewSeg [data-v="' + b.getAttribute('data-v') + '"]'); if (t) t.click();
    setTimeout(syncView, 50); setTimeout(syncView, 600); relayout();
  }));
  bW.addEventListener('click', () => { const w = G.HelmWalkthrough && G.HelmWalkthrough._ui; if (w && w.start) Promise.resolve(w.start()).then(syncView, syncView); setTimeout(syncView, 800); setTimeout(syncView, 3000); });
  doc.addEventListener('keydown', (e) => {
    const t = e.target || {}, typing = /INPUT|SELECT|TEXTAREA/.test(t.tagName || '') || t.isContentEditable;
    const a = fsKey(e, typing); if (!a) return;
    if (doc.querySelector('.modal:not([hidden]), .bpui-overlay')) return;     // a dialog owns the keyboard
    if (a === 'toggle') { e.preventDefault(); toggle(e); }
    else if (a === 'exit' && pseudo) { e.preventDefault(); exit(); }        // native fullscreen exits on Esc itself
  });
  function mount() {
    vp = doc.querySelector('.viewport'); if (!vp) return;
    // the builder's View ▾ menu hosts the Fullscreen item; older hosts keep it beside the View switch
    const slot = doc.getElementById('viewMenuSlot');
    if (slot) { bHead.setAttribute('role', 'menuitem'); slot.append(bHead); }
    else { const viewField = doc.getElementById('viewSeg') && doc.getElementById('viewSeg').closest('.field'); if (viewField) viewField.after(bHead); }
    const stack = doc.getElementById('fabStack');
    if (stack) { stack.prepend(bFab); vp.append(bar); } else vp.append(bFab, bar);
    bar.hidden = true;
    // the 3D/2D switch may change while fullscreen — keep the 2D/3D buttons honest
    const seg = doc.getElementById('viewSeg'); if (seg) seg.addEventListener('click', () => setTimeout(syncView, 50));
  }
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', mount); else mount();
  API._ui = { enter, exit, toggle, isOn, get pseudo() { return pseudo; } };
})(typeof window !== 'undefined' ? window : globalThis);
