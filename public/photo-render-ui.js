/* photo-render-ui.js - the builder's "✦ Render" dialog (migration 0095).
   Captures three reference pictures in the browser - (a) a clean 3D snapshot from the chosen
   camera (no labels), (b) the 2D plan without labels, (c) the 2D plan with names + measurements -
   builds the layout-exact prompt (HelmPhotoPrompt) and sends everything to the edge function
   render-photo (BPStore.photoRender.render). The OpenAI key lives ONLY in that function's secrets.
   Results: gallery with download, "Use in client booklet", regenerate, and past renders per event. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var MAX_W = 1536;
  var state = { busy: false, ac: null, cancelled: false, last: null, cfg: null };

  function toast(m, o) { try { if (window.BPUI && BPUI.toast) BPUI.toast(m, o || {}); } catch (e) {} }
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = String(text); return n; }
  function ctx() { return typeof window.__helmPhotoCtx === 'function' ? window.__helmPhotoCtx() : null; }
  function api() { return window.BPStore && BPStore.photoRender ? BPStore.photoRender : null; }

  // which pictures go with which camera / plan shape
  function outputSize(camera, world) {
    if (camera === 'top' && world && world.h > world.w * 1.1) return '1024x1536';
    return '1536x1024';
  }
  function eyeView(c) {
    try {
      var W = window.HelmWalkthrough; if (!W || !W.walkthroughStops) return null;
      var stops = W.walkthroughStops(c.items, c.world, { aspect: 16 / 9 }) || [];
      var s = stops.filter(function (x) { return x.key === 'entrance'; })[0] || stops.filter(function (x) { return x.view === 'eye'; })[0];
      return s ? { pos: s.pos, target: s.target, fov: s.fov } : null;
    } catch (e) { return null; }
  }
  function cameraOpts(camera, c) {
    var o = { labels: 'none' };
    if (camera === 'top') o.topDown = true;
    else if (camera === 'eye') { var v = eyeView(c); if (v) o.view = v; }
    else { try { var h = window.__helm3D; if (h && h.isActive && h.isActive() && h.getView) { var g = h.getView(); if (g) o.view = { pos: g.pos, target: g.target, fov: g.fov }; } } catch (e) {} }
    return o;
  }
  async function encode(blob) {
    if (!blob) throw new Error('A reference picture could not be drawn');
    var enc = await BPStore.booklet.encodeImage(blob, MAX_W, 0.85);
    if (!enc || !enc.data) throw new Error('A reference picture could not be prepared');
    return { mime: enc.mime, data: enc.data };
  }

  function setStep(text, pct) {
    $('phStep').textContent = text;
    var f = $('phBarFill'); f.className = 'w' + pct;
  }
  function showBusy(on) {
    state.busy = on;
    $('phProgress').hidden = !on;
    $('phGo').disabled = on;
    $('photoForm').querySelectorAll('select,input').forEach(function (n) { n.disabled = on; });
  }
  var OFF_MSG = 'Photo renders aren’t switched on yet — ask your admin.';
  function canManage() { return !!(state.cfg && state.cfg.can_manage); }
  // fetch to an undeployed edge function: CORS preflight 404 -> TypeError "Failed to fetch"
  function isNetErr(e) { return !!e && (e.name === 'TypeError' || /failed to fetch|networkerror|load failed/i.test(String(e.message || ''))); }
  function showOff(msg, admin) {
    $('photoOff').hidden = false;
    $('photoOffMsg').textContent = msg;
    $('photoSetup').hidden = !admin;
  }

  function card(r, src, opts) {
    var c = el('div', 'ph-card');
    var img = el('img'); img.alt = 'Photo render of the event plan'; img.loading = 'lazy';
    if (src) img.src = src;
    c.appendChild(img);
    var when = r.created_at ? new Date(r.created_at) : new Date();
    c.appendChild(el('div', 'ph-meta', [r.style, r.camera, r.quality].filter(Boolean).join(' · ') + ' · ' + when.toLocaleString()));
    var acts = el('div', 'ph-acts');
    var dl = el('a', 'tbtn', 'Download'); dl.download = 'event-photo-' + String(r.id || '').slice(0, 8) + '.jpg';
    var use = el('button', 'tbtn', 'Use in client booklet'); use.type = 'button';
    async function ensureSrc() {
      if (img.src) return img.src;
      var u = await api().image(r.id); if (!u) throw new Error('That photo could not be loaded');
      img.src = u; return u;
    }
    if (src) dl.href = src;
    else {
      var show = el('button', 'tbtn', 'Show'); show.type = 'button';
      show.addEventListener('click', async function () { try { var u = await ensureSrc(); dl.href = u; show.remove(); } catch (e) { toast(String(e.message || e), { type: 'err' }); } });
      acts.appendChild(show);
      dl.addEventListener('click', async function (ev) { if (dl.href) return; ev.preventDefault(); try { dl.href = await ensureSrc(); dl.click(); } catch (e) { toast(String(e.message || e), { type: 'err' }); } });
    }
    use.addEventListener('click', async function () {
      use.disabled = true;
      try { await api().useInBooklet(r.id); toast('Added to the client booklet as its own photo (shown in the 3D section)', { type: 'ok' }); }
      catch (e) { toast(window.BPUI && BPUI.friendlyError ? BPUI.friendlyError(e, { action: 'add the photo to the booklet' }) : String(e.message || e), { type: 'err' }); }
      finally { use.disabled = false; }
    });
    acts.appendChild(dl); acts.appendChild(use);
    if (opts && opts.readOnly) use.hidden = true;
    c.appendChild(acts);
    return c;
  }

  async function loadHistory() {
    var c = ctx(), list = $('phHistList');
    list.replaceChildren();
    if (!c || !c.quoteId || !api()) return;
    try {
      var rows = await api().list(c.quoteId);
      if (!rows.length) { list.appendChild(el('p', 'ph-meta', 'No photo renders for this event yet.')); return; }
      rows.forEach(function (r) { list.appendChild(card(r, null, { readOnly: c.readOnly })); });
    } catch (e) { list.appendChild(el('p', 'ph-meta', 'Past renders could not be loaded.')); }
  }

  async function refreshSettings() {
    var q = $('phQuota'); q.textContent = '';
    state.cfg = null;
    try { state.cfg = api() ? await api().settings() : null; } catch (e) { state.cfg = null; }
    var s = state.cfg;
    if (!s) return;
    if (s.enabled === false) showOff('Photo renders are switched off for your studio — ask your admin.', !!s.can_manage);
    else if (s.can_render === false) showOff('You don’t have permission to make photo renders — ask your admin (Control Center → Users & access → Photo renders).', !!s.can_manage);
    q.textContent = 'This month: ' + (s.used_this_month || 0) + ' of ' + (s.monthly_quota != null ? s.monthly_quota : '—') + ' photos used.';
  }

  async function run(params) {
    var c = ctx(), A = api();
    if (!c || !A) return;
    if (!c.quoteId || !c.supported) { toast('Open a saved event to make photo renders.', { type: 'err' }); return; }
    if (c.frozen) { toast('This event is closed, so new photos can’t be made.', { type: 'err' }); return; }
    if (!c.items.length) { toast('Add some items to the floor first.', { type: 'err' }); return; }
    state.cancelled = false; state.last = params;
    $('phResults').hidden = true; $('photoOff').hidden = true;
    showBusy(true);
    try {
      var evening = false; try { evening = !!(window.__helm3D && __helm3D.isEvening && __helm3D.isEvening()); } catch (e) {}
      var P = window.HelmPhotoPrompt.build({ items: c.items, world: c.world, eventType: c.eventType, guests: c.guests, setting: c.setting,
        evening: evening, style: params.style, camera: params.camera, theme: params.theme, country: c.country });
      setStep('Capturing the 3D view…', 10);
      if (!window.__capture3D) throw new Error('The 3D view is not loaded');
      var b3 = await window.__capture3D(MAX_W, cameraOpts(params.camera, c));
      if (state.cancelled) return;
      setStep('Capturing the floor plan…', 25);
      var b2 = await c.planBlob({ clean: true, maxW: MAX_W, labels: 'none' });
      var b2m = await c.planBlob({ clean: true, maxW: MAX_W, labels: 'names', measure: true });
      if (state.cancelled) return;
      var images = [await encode(b3), await encode(b2), await encode(b2m)];
      setStep('Creating the photo… this takes about a minute' + (params.n > 1 ? ' (' + params.n + ' photos)' : ''), 40);
      state.ac = new AbortController();
      var slow = setTimeout(function () { if (state.busy) setStep('Still working — high quality photos can take up to 3 minutes…', 60); }, 45000);
      var res;
      try {
        res = await A.render({ quote_id: c.quoteId, prompt: P.prompt, n: params.n, quality: params.quality === 'high' ? 'high' : 'standard',
          size: outputSize(params.camera, c.world), style: P.style, camera: P.camera, theme: params.theme, images: images }, state.ac.signal);
      } finally { clearTimeout(slow); }
      setStep('Done', 100);
      var g = $('phGallery'); g.replaceChildren();
      (res.renders || []).forEach(function (r) {
        g.appendChild(card({ id: r.id, style: P.style, camera: P.camera, quality: params.quality }, 'data:' + r.mime + ';base64,' + r.data, { readOnly: c.readOnly }));
      });
      $('phResults').hidden = false;
      if (res.quota != null) $('phQuota').textContent = 'This month: ' + res.used + ' of ' + res.quota + ' photos used.';
      loadHistory();
    } catch (e) {
      if (state.cancelled || (e && e.name === 'AbortError')) { toast('Render cancelled'); return; }
      var code = e && e.code;
      if (code === 'render_not_configured' || isNetErr(e)) showOff(OFF_MSG, canManage());
      else if (code === 'render_quota') toast('Your studio has used this month’s photo renders. ' + String(e.message || ''), { type: 'err' });
      else if (code === 'render_disabled' || code === 'not_allowed') showOff(String(e.message || 'Photo renders are not available to you.'), !!(state.cfg && state.cfg.can_manage));
      else toast(window.BPUI && BPUI.friendlyError ? BPUI.friendlyError(e, { action: 'make the photo' }) : String((e && e.message) || 'The photo could not be made'), { type: 'err' });
    } finally {
      state.ac = null; showBusy(false);
    }
  }

  function readForm() {
    return { style: $('phStyle').value, camera: $('phCamera').value, quality: $('phQuality').value === 'high' ? 'high' : 'standard',
      n: Math.max(1, Math.min(4, parseInt($('phCount').value, 10) || 1)), theme: String($('phTheme').value || '').trim().slice(0, 160) };
  }

  function open() {
    var m = $('photoModal'); if (!m) return;
    var c = ctx();
    var evening = false; try { evening = !!(window.__helm3D && __helm3D.isEvening && __helm3D.isEvening()); } catch (e) {}
    if (c && window.HelmPhotoPrompt) $('phStyle').value = HelmPhotoPrompt.defaultStyle(c.setting, evening);
    $('photoOff').hidden = true; $('phResults').hidden = true;
    m.hidden = false;
    $('phGo').focus();
    var settingsReady = refreshSettings();
    if (!c || !c.quoteId || !c.supported) showOff('Open a saved event (signed in to your studio) to make photo renders.', false);
    else if (!api() || !api().available()) showOff(OFF_MSG, false);
    else if (api().probe) {
      // cheap pre-check: the render-photo function may not be deployed yet (admins see the setup steps)
      Promise.all([api().probe(), settingsReady]).then(function (r) { if (r[0] === false) showOff(OFF_MSG, canManage()); }).catch(function () {});
    }
    loadHistory();
  }
  function close() {
    if (state.busy) cancel();
    $('photoModal').hidden = true;
  }
  function cancel() {
    state.cancelled = true;
    try { if (state.ac) state.ac.abort(); } catch (e) {}
    showBusy(false);
  }

  function wire() {
    var m = $('photoModal'); if (!m) return;
    $('photoForm').addEventListener('submit', function (ev) { ev.preventDefault(); if (!state.busy) run(readForm()); });
    $('phCancel').addEventListener('click', cancel);
    $('phAgain').addEventListener('click', function () { if (!state.busy) run(state.last || readForm()); });
    $('photoX').addEventListener('click', close);
    m.addEventListener('click', function (ev) { if (ev.target === m) close(); });
    m.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') close(); });
    var b = document.querySelector('#viewSeg [data-v="render"]');
    // the 3D render view still opens behind the dialog (that is the "Hero aerial" camera)
    if (b) b.addEventListener('click', function () { setTimeout(open, 0); });
  }
  window.HelmPhotoRenderUI = { open: open, close: close, outputSize: outputSize, cameraOpts: cameraOpts };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire); else wire();
})();
