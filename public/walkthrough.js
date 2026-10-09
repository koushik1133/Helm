/* walkthrough.js — guided 3D venue walkthrough + view presets for the floor builder.
 *
 * Pure part (unit-tested in test/walkthrough.test.mjs):
 *   walkthroughStops(items, hall)  → ordered camera stops generated from the current layout
 *   eveningLightPoints(items, hall) → warm point-light positions for the Evening preset
 *   walkKey(key)                    → 'next' | 'prev' | 'exit' | null
 *   flightMs(reducedMotion)         → 0 (instant) or 1200
 * Coordinates: layout items are in feet (top-left origin, y down); stops are returned in 3D
 * scene units (1 unit = 1 ft, x right, z = layout y, y up, hall centred on the origin).
 *
 * UI part: a "Walkthrough / Overview / Floor plan / Evening / Labels" toolbar field, a floating
 * Walkthrough button when both side panels are collapsed, and the stop overlay. It only reads the
 * layout and moves the camera through window.__helm3D — it never writes the layout, and it is
 * NOT loaded by capture.html (scripts/gen-capture-host.mjs strips it).
 */
(function (G) {
  'use strict';
  const EYE = 5.25;                 // 1.6 m in feet
  const FLY_MS = 1200;
  const SEAT_TYPES = { seatblock: 1, chairrow: 1, chiavari: 1, bleacher: 1, sofa: 1, loveseat: 1, bench: 1 };
  const TABLE_TYPES = { table: 1, longtable: 1, headtable: 1 };
  const SPECIAL = [
    ['photobooth', 'Photo booth', 'Props, backdrop and a spot for guest photos'],
    ['mandap', 'Mandap', 'The ceremony mandap'],
    ['floralarch', 'Floral arch', 'Floral arch for photos and the couple’s entry'],
    ['fountain', 'Fountain', 'Decorative fountain feature'],
    ['chandelier', 'Chandelier', 'Statement chandelier lighting'],
    ['chariot', 'Chariot', 'Entry chariot for the grand arrival'],
    ['caketable', 'Cake table', 'Cake display and cutting table'],
    ['piano', 'Piano', 'Live music corner'],
  ];

  const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);
  function seatsOf(it) {
    const p = it.properties || {};
    if (p.rows && p.cols) return p.rows * p.cols;
    if (p.seats) return +p.seats || 0;
    return it.type === 'chiavari' || it.type === 'barstool' ? 1 : 0;
  }
  function ctr(it) { return { x: num(it.x, 0) + num(it.width, 0) / 2, y: num(it.y, 0) + num(it.height, 0) / 2 }; }
  function rot(ox, oy, deg) { const t = (deg || 0) * Math.PI / 180, c = Math.cos(t), s = Math.sin(t); return [ox * c - oy * s, ox * s + oy * c]; }
  function bbox(list) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const it of list) { x0 = Math.min(x0, it.x); y0 = Math.min(y0, it.y); x1 = Math.max(x1, it.x + it.width); y1 = Math.max(y1, it.y + it.height); }
    return { x: (x0 + x1) / 2, y: (y0 + y1) / 2, r: Math.max(x1 - x0, y1 - y0) / 2 };
  }
  const isType = (it, t) => it.type === t || (t === 'chariot' && /chariot/i.test(String(it.label || '')));
  const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');

  function walkthroughStops(itemsIn, hall) {
    const W = Math.max(10, num(hall && hall.w, 200)), H = Math.max(10, num(hall && hall.h, 140));
    const items = (itemsIn || []).filter((it) => it && typeof it === 'object' && it.type)
      .map((it) => Object.assign({}, it, { x: num(it.x, 0), y: num(it.y, 0), width: Math.max(0, num(it.width, 0)), height: Math.max(0, num(it.height, 0)) }));
    const M = 2;                                                   // keep eye-level cameras 2 ft inside the walls
    const clampX = (x) => Math.max(M, Math.min(W - M, x)), clampY = (y) => Math.max(M, Math.min(H - M, y));
    const S = (fx, fy, h) => [+(fx - W / 2).toFixed(2), +h.toFixed(2), +(fy - H / 2).toFixed(2)];
    const of = (t) => items.filter((it) => isType(it, t));
    const stage = of('stage')[0] || null;
    const stageC = stage ? ctr(stage) : null;
    const stageFront = stage ? rot(0, 1, stage.rotation) : [0, 1];   // stage front faces +y (layout) at rotation 0
    const stops = [];
    const eyeStop = (key, title, desc, eye, look, lookH) => {
      const ex = clampX(eye.x), ey = clampY(eye.y);
      stops.push({ key, title, desc, pos: S(ex, ey, EYE), target: S(look.x, look.y, lookH == null ? 3 : lookH) });
    };
    // camera outside the zone, on the side facing the hall centre (or the given side), looking in
    const zoneStop = (key, title, desc, list, side) => {
      const b = bbox(list);
      let dx = side ? side[0] : W / 2 - b.x, dy = side ? side[1] : H / 2 - b.y;
      const L = Math.hypot(dx, dy); if (L < 1) { dx = 0; dy = 1; } else { dx /= L; dy /= L; }
      const d = Math.max(b.r, 6) + 12;
      eyeStop(key, title, desc, { x: b.x + dx * d, y: b.y + dy * d }, b);
    };
    const overview = (key, title, desc) => {
      const R = Math.max(W, H);
      stops.push({ key, title, desc, pos: [+(W * 0.32).toFixed(2), +(R * 0.62).toFixed(2), +(H * 0.5 + R * 0.38).toFixed(2)], target: [0, 0, 0] });
    };

    overview('overview', 'Venue overview', `${Math.round(W)} × ${Math.round(H)} ft hall · ${plural(items.length, 'item')} in the layout`);

    // Entrance: an exit / gate / arch item, else the hall edge facing the stage
    const ent = items.find((it) => it.type === 'exit' || it.type === 'arch' || it.type === 'checkpoint' || /entr|gate/i.test(String(it.label || '')));
    const lookAt = stageC || { x: W / 2, y: H / 2 };
    if (ent) {
      const c = ctr(ent); let dx = lookAt.x - c.x, dy = lookAt.y - c.y; const L = Math.hypot(dx, dy) || 1;
      eyeStop('entrance', 'Entrance', 'Where guests arrive — the first view of the venue', { x: c.x + dx / L * 6, y: c.y + dy / L * 6 }, lookAt, stage ? 6 : 3);
    } else {
      const ex = stage ? stageC.x + stageFront[0] * W : W / 2, ey = stage ? stageC.y + stageFront[1] * H : H;
      eyeStop('entrance', 'Entrance', 'Walking in from the hall entrance' + (stage ? ' facing the stage' : ''), { x: ex, y: ey }, lookAt, stage ? 6 : 3);
    }

    // Aisle / carpet: stand at the end farther from the stage and look along it
    const carpet = of('redcarpet')[0];
    if (carpet) {
      const c = ctr(carpet), long = Math.max(carpet.width, carpet.height) / 2;
      const ax = carpet.height >= carpet.width ? rot(0, 1, carpet.rotation) : rot(1, 0, carpet.rotation);
      let a = { x: c.x + ax[0] * long, y: c.y + ax[1] * long }, b = { x: c.x - ax[0] * long, y: c.y - ax[1] * long };
      if (stageC && Math.hypot(a.x - stageC.x, a.y - stageC.y) < Math.hypot(b.x - stageC.x, b.y - stageC.y)) { const t = a; a = b; b = t; }
      eyeStop('aisle', 'Aisle walk', `Walking down the ${Math.round(long * 2)} ft ${String(carpet.label || 'carpet').toLowerCase()}`, a, b, EYE - 1);
    }

    // Guest seating
    const seatItems = items.filter((it) => SEAT_TYPES[it.type] || (TABLE_TYPES[it.type] && seatsOf(it) > 0));
    if (seatItems.length) {
      const seats = seatItems.reduce((n, it) => n + seatsOf(it), 0);
      const tables = seatItems.filter((it) => TABLE_TYPES[it.type]);
      const round = tables.filter((it) => it.type === 'table').length;
      let desc = plural(seats, 'seat');
      if (tables.length) desc += ' at ' + plural(tables.length, round === tables.length ? 'round table' : 'table');
      else desc += ' in ' + plural(seatItems.length, 'block');
      const b = bbox(seatItems);
      const back = stage ? [b.x - stageC.x, b.y - stageC.y] : [0, 1];   // stand among the back rows, facing forward
      const L = Math.hypot(back[0], back[1]) || 1;
      eyeStop('seating', 'Guest seating', desc, { x: b.x + back[0] / L * b.r * 0.6, y: b.y + back[1] / L * b.r * 0.6 }, b, 3);
    }

    // Stage, from the front row
    if (stage) {
      const d = Math.max(stage.width, stage.height) / 2;
      const gap = Math.max(14, d * 0.9);
      eyeStop('stage', String(stage.label || '') && !/^stage$/i.test(String(stage.label)) ? 'Main stage — ' + stage.label : 'Main stage',
        `${Math.round(stage.width)} × ${Math.round(stage.height)} ft stage, seen from the front row`,
        { x: stageC.x + stageFront[0] * (stage.height / 2 + gap), y: stageC.y + stageFront[1] * (stage.height / 2 + gap) }, stageC, 6);
    }

    const simple = [
      ['dancefloor', 'Dance floor', (l) => { const it = l[0]; return `${Math.round(it.width)} × ${Math.round(it.height)} ft dance floor`; }],
      ['dining', 'Dining & buffet', (l) => plural(l.filter((i) => i.type === 'buffet').length, 'buffet counter') + (l.some((i) => i.type === 'caketable') ? ' + cake table' : '')],
      ['bar', 'Bar', (l) => plural(l.filter((i) => i.type === 'bar').length, 'bar counter') + (l.some((i) => i.type === 'barstool') ? ' with stools' : '')],
    ];
    const groups = { dancefloor: of('dancefloor'), dining: items.filter((i) => i.type === 'buffet'), bar: items.filter((i) => i.type === 'bar' || i.type === 'barstool') };
    for (const [k, t, f] of simple) if (groups[k].length) zoneStop(k, t, f(groups[k]), groups[k]);

    for (const [t, title, desc] of SPECIAL) {
      if (t === 'caketable' && groups.dining.length) continue;   // already described with dining
      const l = of(t); if (l.length) zoneStop(t, title, l.length > 1 ? desc + ' (' + l.length + ')' : desc, l);
    }
    const screens = items.filter((i) => i.type === 'ledscreen' || i.type === 'videowall');
    if (screens.length) {
      const f = rot(0, 1, screens[0].rotation);
      zoneStop('screen', 'LED screen view', plural(screens.length, 'screen') + ' — the view guests get of the visuals', screens, f);
    }
    if (stops.length > 2) overview('final', 'Final overview', 'That’s the whole venue — drag to look around');
    return stops;
  }

  function eveningLightPoints(items, hall) {
    const W = num(hall && hall.w, 200), H = num(hall && hall.h, 140);
    const pts = [];
    const add = (it, y, k, r) => { const c = ctr(it); pts.push({ x: c.x - W / 2, y, z: c.y - H / 2, k, r }); };
    (items || []).filter((i) => i && i.type === 'stage').slice(0, 2).forEach((s) => add(s, 18, 2.2, 90));
    (items || []).filter((i) => i && (i.type === 'dancefloor' || i.type === 'bar' || i.type === 'chandelier')).slice(0, 3).forEach((s) => add(s, 14, 1.4, 60));
    const tables = (items || []).filter((i) => i && TABLE_TYPES[i.type]);
    const step = Math.max(1, Math.ceil(tables.length / 4));
    for (let i = 0; i < tables.length && pts.length < 8; i += step) add(tables[i], 10, 0.9, 40);
    if (!pts.length) pts.push({ x: 0, y: 20, z: 0, k: 1.4, r: Math.max(W, H) });
    return pts.slice(0, 8);
  }
  function walkKey(key) {
    if (key === 'ArrowRight' || key === 'PageDown' || key === ' ') return 'next';
    if (key === 'ArrowLeft' || key === 'PageUp') return 'prev';
    if (key === 'Escape') return 'exit';
    return null;
  }
  const flightMs = (reduced) => (reduced ? 0 : FLY_MS);
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const topDown = (hall) => { const R = Math.max(num(hall.w, 200), num(hall.h, 140)); return { pos: [0, +(R * 1.05).toFixed(2), 0.01], target: [0, 0, 0] }; };

  const API = { walkthroughStops, eveningLightPoints, walkKey, flightMs, ease, topDown, EYE };
  G.HelmWalkthrough = API;

  /* ------------------------------ UI ------------------------------ */
  const doc = G.document;
  if (!doc || !doc.querySelector || doc.querySelector('meta[name="helm-capture"]')) return;

  function el(tag, cls, text) { const e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function reduced() { try { return !!(G.matchMedia && G.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (_) { return false; } }
  const H3 = () => G.__helm3D;
  const hallNow = () => (typeof WORLD !== 'undefined' ? WORLD : { w: 200, h: 140 });       // eslint-disable-line no-undef
  const itemsNow = () => (typeof store !== 'undefined' && store.items ? store.items : []);  // eslint-disable-line no-undef

  async function ensure3D() {
    if (H3() && H3().isActive()) return true;
    const b = doc.querySelector('#viewSeg [data-v="3d"]'); if (!b) return false;
    b.click();
    for (let i = 0; i < 100; i++) { await new Promise((r) => setTimeout(r, 100)); if (H3() && H3().isActive()) return true; }
    return false;
  }
  let anim = null;
  function fly(to, done) {
    const h = H3(); if (!h) return; const from = h.getView(); if (anim) { G.cancelAnimationFrame(anim); anim = null; }
    const ms = flightMs(reduced());
    if (!ms || !from) { h.setView(to.pos, to.target, 1); if (done) done(); return; }
    const t0 = G.performance.now();
    const lerp = (a, b, k) => a.map((v, i) => v + (b[i] - v) * k);
    const step = (now) => {
      const k = ease(Math.min(1, (now - t0) / ms));
      h.setView(lerp(from.pos, to.pos, k), lerp(from.target, to.target, k), 1);
      if (k < 1) anim = G.requestAnimationFrame(step); else { anim = null; if (done) done(); }
    };
    anim = G.requestAnimationFrame(step);
  }

  // ---- walkthrough state ----
  let W = null;   // { stops, i, saved, from2D, auto, timer }
  const ov = el('div', 'wt-overlay'); ov.hidden = true; ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-label', 'Venue walkthrough');
  const card = el('div', 'wt-card');
  const kicker = el('div', 'wt-kicker'), title = el('div', 'wt-title'), desc = el('div', 'wt-desc'), dots = el('div', 'wt-dots');
  const nav = el('div', 'wt-nav');
  const bPrev = el('button', 'wt-btn', '← Previous stop'), bNext = el('button', 'wt-btn wt-primary', 'Next stop →');
  const bAuto = el('button', 'wt-btn', '▶ Auto-play'), bList = el('button', 'wt-btn', '☰ Zones'), bExit = el('button', 'wt-btn wt-exit', '✕ Exit');
  [bPrev, bNext, bAuto, bList, bExit].forEach((b) => { b.type = 'button'; });
  bAuto.setAttribute('aria-pressed', 'false');
  nav.append(bPrev, bNext, bAuto, bList, bExit);
  const list = el('ol', 'wt-list'); list.hidden = true; list.setAttribute('aria-label', 'Explore the venue');
  card.append(kicker, title, desc, dots, nav);
  ov.append(list, card);

  function show() {
    const s = W.stops[W.i];
    kicker.textContent = `Walkthrough · Stop ${W.i + 1} / ${W.stops.length}`;
    title.textContent = s.title; desc.textContent = s.desc;
    bPrev.disabled = W.i === 0; bNext.textContent = W.i === W.stops.length - 1 ? 'Finish ✓' : 'Next stop →';
    dots.replaceChildren(...W.stops.map((_, k) => { const d = el('span', 'wt-dot' + (k === W.i ? ' on' : '')); return d; }));
    list.querySelectorAll('button').forEach((b, k) => b.classList.toggle('on', k === W.i));
    fly(s);
  }
  function go(i) { if (!W) return; W.i = Math.max(0, Math.min(W.stops.length - 1, i)); show(); }
  function next() { if (!W) return; if (W.i >= W.stops.length - 1) { if (W.auto) setAuto(false); else exit(); return; } go(W.i + 1); }
  function setAuto(on) {
    if (!W) return; W.auto = on; bAuto.setAttribute('aria-pressed', String(on)); bAuto.textContent = on ? '❚❚ Pause' : '▶ Auto-play';
    if (W.timer) { clearInterval(W.timer); W.timer = null; }
    if (on) W.timer = setInterval(() => { if (!W || W.i >= W.stops.length - 1) setAuto(false); else go(W.i + 1); }, 5000 + flightMs(reduced()));
  }
  async function start() {
    if (W) return;
    const from2D = !(H3() && H3().isActive());
    if (!(await ensure3D())) return;
    const stops = walkthroughStops(itemsNow(), hallNow());
    W = { stops, i: 0, saved: H3().getView(), from2D, auto: false, timer: null };
    list.replaceChildren(...stops.map((s, k) => {
      const li = el('li'); const b = el('button', 'wt-zone'); b.type = 'button';
      b.append(el('span', 'wt-zn', String(k + 1).padStart(2, '0')), el('span', null, s.title));
      b.addEventListener('click', () => go(k)); li.append(b); return li;
    }));
    ov.hidden = false; doc.body.classList.add('wt-on'); show(); bNext.focus();
  }
  function exit() {
    if (!W) return; const w = W; W = null; setAuto(false); if (w.timer) clearInterval(w.timer);
    if (anim) { G.cancelAnimationFrame(anim); anim = null; }
    ov.hidden = true; list.hidden = true; doc.body.classList.remove('wt-on');
    if (H3() && w.saved) H3().setView(w.saved.pos, w.saved.target, w.saved.minD);
    if (w.from2D) { const b = doc.querySelector('#viewSeg [data-v="2d"]'); if (b) b.click(); }
  }
  bPrev.addEventListener('click', () => go(W ? W.i - 1 : 0));
  bNext.addEventListener('click', next);
  bAuto.addEventListener('click', () => setAuto(!(W && W.auto)));
  bList.addEventListener('click', () => { list.hidden = !list.hidden; });
  bExit.addEventListener('click', exit);
  G.addEventListener('keydown', (e) => {
    if (!W) return;
    if (e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName || '')) return;
    const a = walkKey(e.key); if (!a) return;
    if (a === 'next' && e.key === ' ' && e.target && e.target.tagName === 'BUTTON') return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (a === 'next') next(); else if (a === 'prev') go(W.i - 1); else exit();
  }, true);

  // ---- presets ----
  async function preset(kind) {
    if (W) exit();
    if (!(await ensure3D())) return;
    const h = H3(), hall = hallNow();
    if (kind === 'overview') fly(walkthroughStops([], hall)[0]);
    else if (kind === 'top') fly(topDown(hall));
    else if (kind === 'evening') { const on = h.setEvening(!h.isEvening()); bEve.setAttribute('aria-pressed', String(on)); bEve.classList.toggle('on', on); }
  }
  let lastLabels = 'names', labelsOn = false;
  function toggleLabels() {
    const cur = doc.querySelector('#labels3d [aria-pressed="true"]');
    const mode = cur ? cur.dataset.l : 'none';
    if (mode !== 'none') lastLabels = mode;
    const nextMode = mode === 'none' ? lastLabels : 'none';
    if (typeof G.__set3DLabels === 'function') G.__set3DLabels(nextMode);
    labelsOn = nextMode !== 'none'; bLab.textContent = labelsOn ? 'Labels on' : 'Labels off'; bLab.setAttribute('aria-pressed', String(labelsOn));
  }
  const field = el('div', 'field wt-field');
  const lbl = el('span', 'flabel', 'Explore'); lbl.id = 'wtLbl';
  const seg = el('div', 'seg'); seg.setAttribute('role', 'group'); seg.setAttribute('aria-labelledby', 'wtLbl');
  const mk = (t, title, fn) => { const b = el('button', null, t); b.type = 'button'; b.title = title; b.addEventListener('click', fn); seg.append(b); return b; };
  const bWalk = mk('⌾ Walkthrough', 'Guided 3D walk through the venue, stop by stop (← → keys, Esc to exit)', start);
  bWalk.id = 'wtStart';
  mk('↗ Overview', 'Three-quarter overview of the whole venue (3D)', () => preset('overview'));
  mk('▧ Floor plan', 'Top-down floor plan in 3D', () => preset('top'));
  const bEve = mk('☾ Evening', 'Evening lighting: darker room, warm lights on the stage and tables', () => preset('evening'));
  bEve.setAttribute('aria-pressed', 'false');
  const bLab = mk('Labels off', 'Show or hide labels in 3D', toggleLabels);
  field.append(lbl, seg);
  const fab = el('button', 'wt-fab', '⌾ Walkthrough'); fab.type = 'button'; fab.hidden = true; fab.title = 'Start the guided venue walkthrough';
  fab.addEventListener('click', start);

  function mount() {
    const viewField = doc.getElementById('viewSeg') && doc.getElementById('viewSeg').closest('.field');
    if (viewField) viewField.after(field);
    const vp = doc.querySelector('.viewport');
    if (vp) vp.append(ov, fab);
    const L = doc.getElementById('leftPanel'), R = doc.getElementById('rightPanel');
    const sync = () => { fab.hidden = !(L && R && L.classList.contains('collapsed') && R.classList.contains('collapsed')); };
    if (L && R && G.MutationObserver) { const mo = new G.MutationObserver(sync); mo.observe(L, { attributes: true, attributeFilter: ['class'] }); mo.observe(R, { attributes: true, attributeFilter: ['class'] }); }
    sync();
    const cur = doc.querySelector('#labels3d [aria-pressed="true"]');
    labelsOn = !!(cur && cur.dataset.l !== 'none'); bLab.textContent = labelsOn ? 'Labels on' : 'Labels off'; bLab.setAttribute('aria-pressed', String(labelsOn));
  }
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', mount); else mount();
  API._ui = { start, exit, preset, state: () => W };
})(typeof window !== 'undefined' ? window : globalThis);
