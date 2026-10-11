/* walkthrough.js — guided 3D venue walkthrough + view presets for the floor builder.
 *
 * Pure part (unit-tested in test/walkthrough.test.mjs):
 *   walkthroughStops(items, hall)  → ordered camera stops generated from the current layout
 *   eveningLightPoints(items, hall) → warm point-light positions for the Evening preset
 *   walkKey(key)                    → 'next' | 'prev' | 'exit' | null
 *   flightMs(reducedMotion, dist)   → 0 (instant) or 1200–2000 ms scaled by travel distance
 *   tweenView(from, to, k)          → camera view at progress k: eased target glide + offset swung on a
 *                                     sphere with log-interpolated radius (distance never overshoots / bounces)
 *   createFlight(...) / makeGate(ms) → one cancellable tween at a time; debounce for rapid Next / Prev
 *
 * Smoothness (owner: "sometimes zooming in, zooming out" between stops) — causes fixed here:
 *   - position and target were lerped independently, so the camera-to-target distance dipped / swelled
 *     mid-flight (and a far overview → close eye stop "zoomed" through the subject);
 *   - FOV jumped 48 ↔ 65 between overview and eye-level stops (a pure zoom); the walkthrough now holds one
 *     constant FOV and only interpolates when a stop explicitly asks for a different one;
 *   - OrbitControls damping inertia (and user drags) kept acting during the tween, and its polar-angle
 *     clamp snapped the camera when a stop looked slightly upward; controls are now paused + damping
 *     flushed during a flight and the clamp relaxed for the walkthrough;
 *   - rapid Next / Prev restarted the flight every click (stutter) — now debounced;
 *   - auto-play ran on a fixed setInterval that could fire mid-flight — now it waits for arrival.
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
  const FLY_MS = 1200, FLY_MAX_MS = 2000, FLY_MS_PER_FT = 4, NAV_GAP_MS = 350, DWELL_MS = 4500;
  const EYE_FOV = 65, OVERVIEW_FOV = 48, WALK_FOV = EYE_FOV, CLEAR = 2;   // eye-level FOV (deg); keep eye cameras 2 ft off footprints
  // floor-level items a guest can stand on (never block an eye-level camera)
  const WALKABLE = { dancefloor: 1, redcarpet: 1, exit: 1, arch: 1, checkpoint: 1, rug: 1, carpet: 1, aisle: 1 };
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

  // axis-aligned footprint of a (possibly rotated) item, grown by `pad` ft
  function footprint(it, pad) {
    const c = ctr(it), hw = it.width / 2, hh = it.height / 2, t = (it.rotation || 0) * Math.PI / 180;
    const ex = Math.abs(hw * Math.cos(t)) + Math.abs(hh * Math.sin(t)), ey = Math.abs(hw * Math.sin(t)) + Math.abs(hh * Math.cos(t));
    return { x0: c.x - ex - pad, y0: c.y - ey - pad, x1: c.x + ex + pad, y1: c.y + ey + pad };
  }
  const blockers = (items) => (items || []).filter((it) => it && it.type && !WALKABLE[it.type] && it.width > 0 && it.height > 0);
  function isClear(p, items, pad) {
    const c = pad == null ? CLEAR : pad;
    return !blockers(items).some((it) => { const f = footprint(it, c); return p.x > f.x0 && p.x < f.x1 && p.y > f.y0 && p.y < f.y1; });
  }
  /* Nudge an eye-level camera spot `p` (layout ft) out of every object footprint (+CLEAR ft), keeping
     it inside the hall. Tries backing away from `look` first, then sideways, then forward, in growing
     steps; returns the nearest free spot (or p unchanged if it is already clear / nothing is free). */
  function clearSpot(p, look, items, hall, pad) {
    const W = Math.max(10, num(hall && hall.w, 200)), H = Math.max(10, num(hall && hall.h, 140)), M = 2;
    const inHall = (q) => q.x >= M && q.x <= W - M && q.y >= M && q.y <= H - M;
    const list = blockers(items);
    if (isClear(p, list, pad)) return { x: p.x, y: p.y };
    let fx = (look ? look.x : W / 2) - p.x, fy = (look ? look.y : H / 2) - p.y; const L = Math.hypot(fx, fy);
    if (L < 1e-6) { fx = 0; fy = -1; } else { fx /= L; fy /= L; }
    const dirs = [[-fx, -fy], [-fy, fx], [fy, -fx], [fx, fy],
      [(-fx - fy) / Math.SQRT2, (-fy + fx) / Math.SQRT2], [(-fx + fy) / Math.SQRT2, (-fy - fx) / Math.SQRT2]];
    for (let d = 0.5; d <= Math.max(W, H); d += 0.5) {
      for (const [dx, dy] of dirs) {
        const q = { x: p.x + dx * d, y: p.y + dy * d };
        if (inHall(q) && isClear(q, list, pad)) return { x: +q.x.toFixed(2), y: +q.y.toFixed(2) };
      }
    }
    return { x: p.x, y: p.y };
  }
  /* Overview camera: three-quarter view framing the hall floor box to `fill` (~80%) of the viewport on
     the binding axis, for the live camera aspect / FOV. Uses HelmCaptureFrame.frameBox when loaded,
     else an equivalent conservative fit. Scene units, hall centred on the origin. */
  function overviewView(hall, aspect, fovDeg, fill) {
    const W = Math.max(10, num(hall && hall.w, 200)), H = Math.max(10, num(hall && hall.h, 140));
    const a = num(aspect, 16 / 9) > 0.2 ? num(aspect, 16 / 9) : 16 / 9, fov = num(fovDeg, OVERVIEW_FOV), f = num(fill, 0.8);
    const box = { min: [-W / 2, 0, -H / 2], max: [W / 2, 4, H / 2] };
    const o = { aspect: a, fovDeg: fov, fill: f, elevationDeg: 40, azimuthDeg: 30, minDist: 20 };
    const CF = G.HelmCaptureFrame;
    let pos, target;
    if (CF && typeof CF.frameBox === 'function') { const fr = CF.frameBox(box, o); pos = fr.position; target = fr.target; }
    else {
      const el = 40 * Math.PI / 180, az = 30 * Math.PI / 180, dir = [Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)];
      const tanV = Math.tan(fov * Math.PI / 360), R = Math.hypot(W, H) / 2;
      const d = R / (Math.min(tanV, tanV * a) * f) * 0.6 + 4;
      target = [0, 0, 0]; pos = dir.map((v) => v * d);
    }
    const r2 = (v) => +v.toFixed(2);
    return { pos: pos.map(r2), target: target.map(r2), fov };
  }
  // label sprites: shown at overview stops, hidden at eye level; an explicit user toggle wins
  function stopShowsLabels(stop, override) {
    if (override === true || override === false) return override;
    return !!(stop && stop.view === 'overview');
  }

  /* Entry points a guest can arrive through, best first: security checkpoint → entrance arch / floral
     arch / entrance desk → exit marked as an entry → other exits → "Back centre" (the hall edge facing
     the stage). Each gets a stable id (item id) and a human label with where it sits as seen by a guest
     facing the stage, e.g. "Security check (back-right)". */
  const ENTRY_RX = /entr|entry|gate|arriv|welcome|reception/i;
  function entryCandidates(itemsIn, hall) {
    const W = Math.max(10, num(hall && hall.w, 200)), H = Math.max(10, num(hall && hall.h, 140));
    const items = (itemsIn || []).filter((it) => it && typeof it === 'object' && it.type)
      .map((it) => Object.assign({}, it, { x: num(it.x, 0), y: num(it.y, 0), rotation: num(+it.rotation, 0), width: Math.max(0, num(it.width, 0)), height: Math.max(0, num(it.height, 0)) }));
    const stage = items.find((it) => it.type === 'stage');
    const sc = stage ? ctr(stage) : { x: W / 2, y: 0 };
    const front = stage ? rot(0, 1, stage.rotation) : [0, 1];             // from the stage toward the guests
    const right = [front[1], -front[0]];                                   // guest faces -front; their right
    const where = (p) => {
      const rx = p.x - W / 2, ry = p.y - H / 2;
      const along = (rx * front[0] + ry * front[1]) / (Math.abs(front[0]) * W / 2 + Math.abs(front[1]) * H / 2 || 1);
      const side = (rx * right[0] + ry * right[1]) / (Math.abs(right[0]) * W / 2 + Math.abs(right[1]) * H / 2 || 1);
      const a = along > 0.33 ? 'back' : along < -0.33 ? 'front' : 'middle', b = side > 0.33 ? 'right' : side < -0.33 ? 'left' : 'centre';
      return a === 'middle' && b === 'centre' ? 'centre' : a === 'middle' ? b + ' side' : a + '-' + b;
    };
    const out = [], seen = {};
    const add = (it, rank, name) => { const id = String(it.id || it.type + '@' + Math.round(it.x) + ',' + Math.round(it.y)); if (seen[id]) return; seen[id] = 1;
      const c = ctr(it); out.push({ id, rank, label: name + ' (' + where(c) + ')', x: c.x, y: c.y, type: it.type }); };
    const lbl = (it) => String(it.label || '');
    items.filter((it) => it.type === 'checkpoint').forEach((it, i, a) => add(it, 0, 'Security check' + (a.length > 1 ? ' ' + (i + 1) : '')));
    items.filter((it) => it.type === 'arch' || it.type === 'floralarch' || (it.type === 'desk' && ENTRY_RX.test(lbl(it))) || (it.type !== 'exit' && it.type !== 'stage' && /entr|gate/i.test(lbl(it))))
      .forEach((it) => add(it, 1, it.type === 'floralarch' ? 'Floral arch' : it.type === 'desk' ? 'Entrance desk' : it.type === 'arch' ? 'Entrance arch' : (lbl(it) || 'Entrance')));
    const exits = items.filter((it) => it.type === 'exit');
    exits.filter((it) => ENTRY_RX.test(lbl(it))).forEach((it) => add(it, 2, lbl(it) || 'Entry'));
    exits.forEach((it, i) => add(it, 3, 'Exit ' + (i + 1)));
    out.sort((a, b) => a.rank - b.rank);
    // back centre: the hall edge opposite the stage
    const bx = stage ? sc.x + front[0] * W : W / 2, by = stage ? sc.y + front[1] * H : H;
    out.push({ id: 'back-centre', rank: 4, label: 'Back centre', x: Math.max(2, Math.min(W - 2, bx)), y: Math.max(2, Math.min(H - 2, by)), type: 'edge' });
    return out;
  }

  function walkthroughStops(itemsIn, hall, opts) {
    const aspect = opts && opts.aspect;
    const W = Math.max(10, num(hall && hall.w, 200)), H = Math.max(10, num(hall && hall.h, 140));
    const items = (itemsIn || []).filter((it) => it && typeof it === 'object' && it.type)
      .map((it) => Object.assign({}, it, { x: num(it.x, 0), y: num(it.y, 0), rotation: num(+it.rotation, 0), width: Math.max(0, num(it.width, 0)), height: Math.max(0, num(it.height, 0)) }));
    const M = 2;                                                   // keep eye-level cameras 2 ft inside the walls
    const clampX = (x) => Math.max(M, Math.min(W - M, x)), clampY = (y) => Math.max(M, Math.min(H - M, y));
    const S = (fx, fy, h) => [+(fx - W / 2).toFixed(2), +h.toFixed(2), +(fy - H / 2).toFixed(2)];
    const of = (t) => items.filter((it) => isType(it, t));
    const stage = of('stage')[0] || null;
    const stageC = stage ? ctr(stage) : null;
    const stageFront = stage ? rot(0, 1, stage.rotation) : [0, 1];   // stage front faces +y (layout) at rotation 0
    const stops = [];
    const eyeStop = (key, title, desc, eye, look, lookH) => {
      const p = clearSpot({ x: clampX(eye.x), y: clampY(eye.y) }, look, items, { w: W, h: H });
      stops.push({ key, title, desc, view: 'eye', fov: EYE_FOV, pos: S(p.x, p.y, EYE), target: S(look.x, look.y, lookH == null ? 3 : lookH) });
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
      const v = overviewView({ w: W, h: H }, aspect, WALK_FOV, 0.8);   // same FOV as the eye stops: no zoom jumps
      stops.push({ key, title, desc, view: 'overview', fov: v.fov, pos: v.pos, target: v.target });
    };

    overview('overview', 'Venue overview', `${Math.round(W)} × ${Math.round(H)} ft hall · ${plural(items.length, 'item')} in the layout`);

    // Entrance: the chosen (or best) real entry point, standing just inside it at eye level, looking
    // LEVEL into the venue toward the stage — a wide first view, never a close-up of the entry item.
    const cands = entryCandidates(items, { w: W, h: H });
    const want = opts && opts.entry;
    const ent = cands.find((c) => c.id === want) || cands[0];
    const lookAt = stageC || { x: W / 2, y: H / 2 };
    {
      let dx = lookAt.x - ent.x, dy = lookAt.y - ent.y; const L = Math.hypot(dx, dy) || 1;
      const step = ent.type === 'edge' ? 0 : Math.min(6, L * 0.15);       // just inside the entry, toward the venue
      const desc = ent.type === 'edge' ? 'Walking in from the hall entrance' + (stage ? ' facing the stage' : '')
        : 'Arriving through the ' + ent.label.replace(/ \(.*\)$/, '').toLowerCase() + ' — the first view of the venue';
      eyeStop('entrance', 'Entrance', desc, { x: ent.x + dx / L * step, y: ent.y + dy / L * step }, lookAt, EYE);
      stops[stops.length - 1].entry = ent.id;
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
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const len = (a) => Math.hypot(a[0], a[1], a[2]);
  // total travel (camera + look-at point), in scene ft
  const travel = (from, to) => (from && to ? len(sub(to.pos, from.pos)) + len(sub(to.target, from.target)) : 0);
  function flightMs(reduced, dist) {
    if (reduced) return 0;
    if (!(dist > 0)) return FLY_MS;
    return Math.round(Math.min(FLY_MAX_MS, FLY_MS + dist * FLY_MS_PER_FT));
  }
  const ease = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  /* View at raw progress k (0..1, eased here). The look-at point glides on a straight line; the camera
     offset from it swings on a sphere (slerp of the direction) while its length is interpolated in log
     space, so the camera-to-target distance changes monotonically from start to end — no dip / swell. */
  function tweenView(from, to, k) {
    const e = ease(k), mix = (a, b) => a + (b - a) * e;
    const target = from.target.map((v, i) => mix(v, to.target[i]));
    const oa = sub(from.pos, from.target), ob = sub(to.pos, to.target);
    const ra = Math.max(1e-3, len(oa)), rb = Math.max(1e-3, len(ob));
    const ua = oa.map((v) => v / ra), ub = ob.map((v) => v / rb);
    const r = Math.exp(mix(Math.log(ra), Math.log(rb)));
    const dot = Math.max(-1, Math.min(1, ua[0] * ub[0] + ua[1] * ub[1] + ua[2] * ub[2]));
    let u;
    if (dot > 0.9999) u = ua.map((v, i) => v + (ub[i] - v) * e);
    else if (dot < -0.9999) {            // opposite directions: swing over the top (y up)
      const p = [0, 1, 0], c = Math.cos(Math.PI * e), s = Math.sin(Math.PI * e);
      u = ua.map((v, i) => v * c + p[i] * s);
    } else {
      const th = Math.acos(dot), sn = Math.sin(th), wa = Math.sin((1 - e) * th) / sn, wb = Math.sin(e * th) / sn;
      u = ua.map((v, i) => v * wa + ub[i] * wb);
    }
    const ul = len(u) || 1;
    const f0 = num(from.fov, WALK_FOV), f1 = num(to.fov, f0);
    return { pos: target.map((v, i) => v + u[i] / ul * r), target, fov: f0 + (f1 - f0) * e };
  }
  /* One flight. apply(view) each frame, done() once at the end; cancel() stops it without calling done.
     raf / caf / now are injected so the unit tests can drive frames by hand. */
  function createFlight(o) {
    const raf = o.raf, caf = o.caf, now = o.now, ms = num(o.ms, FLY_MS);
    let id = null, dead = false; const t0 = now();
    const finish = () => { if (dead) return; dead = true; o.apply({ pos: o.to.pos.slice(), target: o.to.target.slice(), fov: num(o.to.fov, num(o.from && o.from.fov, WALK_FOV)) }); if (o.done) o.done(); };
    if (!(ms > 0) || !o.from) { finish(); return { cancel() {}, get active() { return false; } }; }
    const step = () => {
      if (dead) return;
      const k = Math.min(1, (now() - t0) / ms);
      if (k >= 1) { id = null; finish(); return; }
      o.apply(tweenView(o.from, o.to, k)); id = raf(step);
    };
    id = raf(step);
    return { cancel() { dead = true; if (id != null) caf(id); id = null; }, get active() { return !dead; } };
  }
  // rapid-click gate: allow() is true at most once per `ms`
  function makeGate(ms, now) { let last = -Infinity; return { allow() { const t = now(); if (t - last < ms) return false; last = t; return true; }, reset() { last = -Infinity; } }; }
  const topDown = (hall) => { const R = Math.max(num(hall.w, 200), num(hall.h, 140)); return { pos: [0, +(R * 1.05).toFixed(2), 0.01], target: [0, 0, 0] }; };

  const API = { walkthroughStops, eveningLightPoints, walkKey, flightMs, ease, topDown, EYE, EYE_FOV, WALK_FOV, CLEAR, overviewView, clearSpot, isClear, stopShowsLabels,
    tweenView, createFlight, makeGate, travel, NAV_GAP_MS, DWELL_MS, entryCandidates };
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
  let flight = null;   // the single in-flight camera tween
  const nowMs = () => G.performance.now();
  function stopFlight() { if (flight) { flight.cancel(); flight = null; } const h = H3(); if (h && h.setFlying) h.setFlying(false); }
  function fly(to, done) {
    const h = H3(); if (!h) return; stopFlight();
    const from = h.getView();
    const ms = flightMs(reduced(), travel(from, to));
    if (h.setFlying) h.setFlying(true);   // controls paused + damping inertia flushed for the whole glide
    flight = createFlight({ from, to, ms, now: nowMs, raf: (f) => G.requestAnimationFrame(f), caf: (id) => G.cancelAnimationFrame(id),
      apply: (v) => h.setView(v.pos, v.target, null, v.fov),
      done: () => { flight = null; if (h.setFlying) h.setFlying(false); if (done) done(); } });
  }

  // ---- walkthrough state ----
  let W = null;   // { stops, i, saved, from2D, auto, timer }
  const ov = el('div', 'wt-overlay'); ov.hidden = true; ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-label', 'Venue walkthrough');
  const card = el('div', 'wt-card');
  const kicker = el('div', 'wt-kicker'), title = el('div', 'wt-title'), desc = el('div', 'wt-desc'), dots = el('div', 'wt-dots');
  const nav = el('div', 'wt-nav');
  const bPrev = el('button', 'wt-btn', '← Previous stop'), bNext = el('button', 'wt-btn wt-primary', 'Next stop →');
  const bWLab = el('button', 'wt-btn', 'Labels');
  const bAuto = el('button', 'wt-btn', '▶ Auto-play'), bList = el('button', 'wt-btn', '☰ Zones'), bExit = el('button', 'wt-btn wt-exit', '✕ Exit');
  [bPrev, bNext, bAuto, bWLab, bList, bExit].forEach((b) => { b.type = 'button'; });
  bAuto.setAttribute('aria-pressed', 'false');
  bWLab.title = 'Show or hide name tags during the walkthrough';
  nav.append(bPrev, bNext, bAuto, bWLab, bList, bExit);
  const list = el('ol', 'wt-list'); list.hidden = true; list.setAttribute('aria-label', 'Explore the venue');
  // "Start from": every entry point found in the layout; the choice is remembered per quote
  const fromWrap = el('label', 'wt-from'); const fromSel = el('select', 'wt-from-sel');
  fromSel.setAttribute('aria-label', 'Start the walkthrough from');
  fromWrap.append(el('span', 'wt-from-lbl', 'Start from'), fromSel);
  card.append(kicker, title, desc, fromWrap, dots, nav);
  const entryKey = () => { let q = ''; try { q = new URLSearchParams(G.location.search).get('quote') || ''; } catch (_) {} return 'helm.wt.entry.' + (q.replace(/[^A-Za-z0-9-]/g, '').slice(0, 64) || 'draft'); };
  const loadEntry = () => { try { return G.localStorage.getItem(entryKey()) || ''; } catch (_) { return ''; } };
  const saveEntry = (v) => { try { G.localStorage.setItem(entryKey(), v); } catch (_) {} };
  fromSel.addEventListener('change', () => {
    if (!W) return; saveEntry(fromSel.value);
    const keepAuto = W.auto; W.entry = fromSel.value;
    W.stops = walkthroughStops(itemsNow(), hallNow(), { aspect: W.saved && W.saved.aspect, entry: W.entry });
    paintList();
    const ei = W.stops.findIndex((x) => x.key === 'entrance'); W.i = ei < 0 ? 0 : ei; show(); if (keepAuto) setAuto(true);
  });
  ov.append(list, card);

  function show() {
    const s = W.stops[W.i];
    kicker.textContent = `Walkthrough · Stop ${W.i + 1} / ${W.stops.length}`;
    title.textContent = s.title; desc.textContent = s.desc;
    bPrev.disabled = W.i === 0; bNext.textContent = W.i === W.stops.length - 1 ? 'Finish ✓' : 'Next stop →';
    dots.replaceChildren(...W.stops.map((_, k) => { const d = el('span', 'wt-dot' + (k === W.i ? ' on' : '')); return d; }));
    list.querySelectorAll('button').forEach((b, k) => b.classList.toggle('on', k === W.i));
    syncLabels();
    clearAutoTimer();
    fly(s, arrived);
  }
  function clearAutoTimer() { if (W && W.timer) { clearTimeout(W.timer); W.timer = null; } }
  // auto-play paces from ARRIVAL: dwell, then fly on — never fires mid-flight
  function arrived() {
    if (!W || !W.auto) return; clearAutoTimer();
    W.timer = setTimeout(() => { if (!W || !W.auto) return; W.timer = null; if (W.i >= W.stops.length - 1) setAuto(false); else go(W.i + 1); }, DWELL_MS);
  }
  function paintList() {
    list.replaceChildren(...W.stops.map((s, k) => {
      const li = el('li'); const b = el('button', 'wt-zone'); b.type = 'button';
      b.append(el('span', 'wt-zn', String(k + 1).padStart(2, '0')), el('span', null, s.title));
      b.addEventListener('click', () => go(k)); li.append(b); return li;
    }));
  }
  function syncLabels() {
    if (!W) return; const on = stopShowsLabels(W.stops[W.i], W.labels);
    bWLab.setAttribute('aria-pressed', String(on)); bWLab.textContent = on ? 'Labels on' : 'Labels off';
    const h = H3(); if (h && h.setLabelsHidden) h.setLabelsHidden(!on);
  }
  function go(i) { if (!W) return; const j = Math.max(0, Math.min(W.stops.length - 1, i)); if (j === W.i && flight) return; W.i = j; show(); }
  const navGate = makeGate(NAV_GAP_MS, nowMs);
  function step(d) { if (!W || !navGate.allow()) return; if (d > 0) next(); else go(W.i - 1); }
  function next() { if (!W) return; if (W.i >= W.stops.length - 1) { if (W.auto) setAuto(false); else exit(); return; } go(W.i + 1); }
  function setAuto(on) {
    if (!W) return; W.auto = on; bAuto.setAttribute('aria-pressed', String(on)); bAuto.textContent = on ? '❚❚ Pause' : '▶ Auto-play';
    clearAutoTimer();
    if (on && !flight) arrived();
  }
  async function start() {
    if (W) return;
    const from2D = !(H3() && H3().isActive());
    if (!(await ensure3D())) return;
    const saved = H3().getView();
    const cands = entryCandidates(itemsNow(), hallNow());
    const remembered = loadEntry(); const entry = cands.some((c) => c.id === remembered) ? remembered : cands[0].id;
    fromSel.replaceChildren(...cands.map((c) => { const o = el('option', null, c.label); o.value = c.id; return o; }));
    fromSel.value = entry;
    const stops = walkthroughStops(itemsNow(), hallNow(), { aspect: saved && saved.aspect, entry });
    W = { stops, i: 0, saved, from2D, auto: false, timer: null, labels: null, entry };
    if (H3().setWalkMode) H3().setWalkMode(true);   // relax the polar clamp / min distance once, not per frame
    paintList();
    ov.hidden = false; doc.body.classList.add('wt-on'); show(); bNext.focus();
  }
  function exit() {
    if (!W) return; const w = W; W = null; if (w.timer) clearTimeout(w.timer);
    stopFlight();
    if (H3() && H3().setWalkMode) H3().setWalkMode(false);
    ov.hidden = true; list.hidden = true; doc.body.classList.remove('wt-on');
    if (H3() && H3().setLabelsHidden) H3().setLabelsHidden(false);   // back to the user's own label mode
    if (H3() && w.saved) H3().setView(w.saved.pos, w.saved.target, w.saved.minD, w.saved.fov);
    if (w.from2D) { const b = doc.querySelector('#viewSeg [data-v="2d"]'); if (b) b.click(); }
  }
  bPrev.addEventListener('click', () => step(-1));
  bNext.addEventListener('click', () => step(1));
  bAuto.addEventListener('click', () => setAuto(!(W && W.auto)));
  bWLab.addEventListener('click', () => { if (!W) return; W.labels = !stopShowsLabels(W.stops[W.i], W.labels); syncLabels(); });
  bList.addEventListener('click', () => { list.hidden = !list.hidden; });
  bExit.addEventListener('click', exit);
  // using anything else in the builder (toolbar, panels, toolbox, 2D/3D switch...) ends the walkthrough first,
  // so every feature works normally - no need to press Exit. Clicks on the walkthrough card or the 3D view itself don't.
  doc.addEventListener('pointerdown', (e) => {
    if (!W) return; const t = e.target;
    if (!t || !t.closest || ov.contains(t) || t.closest('.wt-overlay, .wt-list, canvas, #scene3d, #fabStack, .modal, .bpui-overlay')) return;
    const to2D = !!t.closest('#viewSeg [data-v="2d"]');
    if (to2D) W.from2D = false;   // the click itself switches to 2D - don't switch twice
    exit();
  }, true);
  G.addEventListener('keydown', (e) => {
    if (!W) return;
    if (e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName || '')) return;
    const a = walkKey(e.key); if (!a) return;
    if (a === 'next' && e.key === ' ' && e.target && e.target.tagName === 'BUTTON') return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (a === 'next') step(1); else if (a === 'prev') step(-1); else exit();
  }, true);

  // ---- presets ----
  async function preset(kind) {
    if (W) exit();
    if (!(await ensure3D())) return;
    const h = H3(), hall = hallNow();
    const v0 = h.getView();
    if (kind === 'overview') fly(overviewView(hall, v0 && v0.aspect, OVERVIEW_FOV, 0.8));
    else if (kind === 'top') fly(Object.assign({ fov: OVERVIEW_FOV }, topDown(hall)));
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
    // the builder's View ▾ menu hosts the explore controls; older hosts keep them beside the View switch
    const slot = doc.getElementById('viewMenuSlot');
    if (slot) { field.classList.add('tm-group'); seg.querySelectorAll('button').forEach((b) => b.setAttribute('role', 'menuitem')); slot.prepend(field); }
    else { const viewField = doc.getElementById('viewSeg') && doc.getElementById('viewSeg').closest('.field'); if (viewField) viewField.after(field); }
    const vp = doc.querySelector('.viewport');
    // one floating stack (bottom-right) holds every canvas control so nothing overlaps
    const stack = doc.getElementById('fabStack');
    if (vp) { vp.append(ov); if (stack) stack.prepend(fab); else vp.append(fab); }
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
