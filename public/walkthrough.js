/* walkthrough.js — guided 3D venue walkaround + view presets for the floor builder.
 *
 * R49 (owner: "intelligently track all the things without overlapping or missing anything or doing something
 * weird"). One coherent design, all of it pure + exported for the tests (test/walkthrough*.test.mjs):
 *
 *  COVERAGE   walkthroughStops(items, hall, opts) plans the tour. Every kept item is OWNED by exactly one stop
 *             (stop.owns). Accessories (uplights, centrepieces, speakers...) ride with the thing they sit on or
 *             next to; nested items (mandap on the stage, chairs round a table) belong to their host; roofs,
 *             exits and loose decor belong to the overview. Everything else is a subject: subjects of one
 *             family (seating, food, bar...) are clustered by gap with a span cap, unknown types get their own
 *             stop, and a group that cannot be framed legibly is split. proveCoverage() checks the contract.
 *  FRAMING    one FOV per walk from the aspect (walkFov); a real 3D box per stop (rotated footprints x heights,
 *             or the live meshes via opts.bounds); heading rules (stage / screen front, long side square-on,
 *             carpets along their length); pitch by kind; closed-form distance refined into the CLEAR band
 *             (the part of the canvas the stop card / top bar do not cover); orbit pivot on the subject.
 *  OCCLUSION  solidsOf() is the shared solid model (heights from HelmCaptureFrame.ITEM_TOP; roofs / hanging
 *             items never block a standing spot); camOK + 3-ray visibility pick the camera (placeCamera never
 *             returns an unchecked spot); planPath gives a flight path that clears every solid.
 *  MOTION     planFlight / viewAt: the eye and the head move separately (smootherstep, shortest yaw, pitch in
 *             [-80, 35] deg, eye >= 4 ft), duration from distance + turn; createFlight runs on a pausable
 *             frame-delta clock and can hand its speed to the next flight (Next mid-flight never brakes).
 *  UI         count-first captions, "Stop 4 of 9", button dots, Space/K play-pause, arrows, Home/End, Esc,
 *             aria-live, a mobile sheet with swipe, subject highlight; any drag / wheel / pinch on the 3D view
 *             takes over ("Paused — exploring"); layout-editing keys are blocked while the tour is open.
 * Coordinates: layout items are in feet (top-left origin, y down); stops are returned in 3D scene units
 * (1 unit = 1 ft, x right, z = layout y, y up, hall centred on the origin).
 * It only reads the layout and moves the camera through window.__helm3D — it never writes the layout, and it
 * is NOT loaded by capture.html (scripts/gen-capture-host.mjs strips it).
 */
(function (G) {
  'use strict';
  // hot built-ins as locals: one scope lookup instead of a global one per call (much faster in node's vm sandbox, free in browsers)
  const Math = globalThis.Math, Map = globalThis.Map, Set = globalThis.Set, Float64Array = globalThis.Float64Array, Int32Array = globalThis.Int32Array, Number = globalThis.Number,
    Array = globalThis.Array, Object = globalThis.Object, String = globalThis.String, isFinite = globalThis.isFinite, Infinity = globalThis.Infinity;
  const DEG = Math.PI / 180;
  const EYE = 5.25;                 // 1.6 m in feet
  const EYE_MIN = 4;                // the camera never flies lower than this
  const CLEAR = 2, MARGIN = 2;      // ft kept between a camera and any solid / the hall edge
  const PITCH_MIN = -80 * DEG, PITCH_MAX = 35 * DEG;
  const OVERVIEW_FOV = 48, BASE_FOV = 55, HMIN_FOV = 42, MAX_FOV = 78;
  const WALK_FOV = BASE_FOV, EYE_FOV = BASE_FOV;
  const FILL = 0.72;   // of the clear band: a little margin for the real meshes (chairs, drapes) beyond the footprint
  const LIN_FTPS = 28, ANG_DPS = 70, MIN_MS = 900, MAX_MS = 4200;
  const NAV_GAP_MS = 120, DWELL_MS = 4500;
  const DEFAULT_BAND = { t: 0.07, b: 0.24, l: 0, r: 0 };   // typical desktop: top tool bar + bottom stop card

  // ---------------- small helpers ----------------
  const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);
  const fnum = (v, d) => num(typeof v === 'string' && v.trim() !== '' ? +v : v, d);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  const r2 = (v) => +(+v).toFixed(2);
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const len = (a) => Math.hypot(a[0], a[1], a[2]);
  const lerp3 = (a, b, e) => [a[0] + (b[0] - a[0]) * e, a[1] + (b[1] - a[1]) * e, a[2] + (b[2] - a[2]) * e];
  const bag = (s) => { const o = Object.create(null); s.split(/\s+/).forEach((k) => { if (k) o[k] = 1; }); return o; };   // own-property sets
  const map = (o) => Object.assign(Object.create(null), o);
  const clock = () => (G.performance && G.performance.now ? G.performance.now() : Date.now());
  const topOf = (t) => { const CF = G.HelmCaptureFrame; return CF && CF.itemTop ? CF.itemTop(t) : 2.6; };
  function hallOf(hall) { return { W: Math.max(10, fnum(hall && hall.w, 200)), H: Math.max(10, fnum(hall && hall.h, 140)) }; }
  function rot(ox, oy, deg) { const t = (deg || 0) * DEG, c = Math.cos(t), s = Math.sin(t); return [ox * c - oy * s, ox * s + oy * c]; }
  const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');

  // ---------------- classification ----------------
  // never a subject: rides with the item it sits on / next to (or the overview when it is loose)
  const ACCESSORY = bag('uplight centrepiece floral cableramp distro micstand monitor movinghead smoke pyro aircooler heater kalash balloonbunch lanterns ' +
    'aislefloral signage easel speaker subwoofer linearray lightingtree truss drape fence barricade stagebarrier flagstand diyastand floralpillar pillar planter ' +
    'urli welcomeboard ottoman coffeetable teleprompter toran floralstand decorbox stanchion extinguisher');
  const ENVELOPE = bag('tent canopy stageroof fairylights hangingfloral umbrellas parking');   // overhead / area: shown by the overview
  const MARKER = bag('exit checkpoint arch');                                                  // entry / exit markers: the overview (or the entrance)
  const ROOF = bag('tent canopy stageroof umbrellas');
  const HANG = map({ chandelier: [8, 12.5], hangingfloral: [9, 13], fairylights: [9, 13.5] });
  const FLOOR = bag('dancefloor redcarpet rug carpet aisle exit arch checkpoint walkway');     // you can stand on it
  const PATH = bag('redcarpet walkway aisle carpet');
  const HOST = bag('stage dais varmala viprisers mandap lounge kidszone haldi mehendi greenroom press dancefloor table longtable headtable recttable cocktail bar buffet');
  const TABLES = bag('table longtable headtable recttable cocktail');
  const SEATS = bag('seatblock chairrow chiavari bleacher sofa loveseat bench gaddi couplesofa armchair');
  const SATELLITE = bag('ledscreen videowall led projector podium lectern stagebackdrop linearray speaker subwoofer lighting');
  const FRONTED = bag('stage ledscreen videowall led photobooth backdrop selfieframe stagebackdrop brandwall piano mandap floralarch entrancegate projector tvstand');
  const FAMILY = map({
    table: 'seating', longtable: 'seating', recttable: 'seating', chairrow: 'seating', seatblock: 'seating', chiavari: 'seating', bench: 'seating', gaddi: 'seating',
    cocktail: 'cocktail', bleacher: 'bleacher', headtable: 'headtable', stage: 'stage', dancefloor: 'dancefloor',
    redcarpet: 'aisle', walkway: 'aisle', aisle: 'aisle', carpet: 'aisle',
    sofa: 'lounge', loveseat: 'lounge', armchair: 'lounge', couplesofa: 'lounge', lounge: 'lounge',
    buffet: 'food', livecounter: 'food', chocolatefountain: 'food', caketable: 'food', truck: 'food', dessert: 'food', coffee: 'food',
    bar: 'bar', barstool: 'bar', booth: 'expo', stall: 'expo', kiosk: 'expo',
    restroom: 'service', coatcheck: 'service', firstaid: 'service', gifttable: 'service', desk: 'service', shoerack: 'service', ticketbooth: 'service',
    foh: 'production', dj: 'production', generator: 'production', towerlight: 'production', interpreter: 'production',
    ledscreen: 'screen', videowall: 'screen', led: 'screen', projector: 'screen', tvstand: 'screen',
  });
  const MERGE_GAP = map({ seating: 40, food: 30, bar: 20, expo: 20, service: 15, production: 15, lounge: 25, cocktail: 25, screen: 0, bleacher: 12, headtable: 0, stage: 0, dancefloor: 0, aisle: 0 });
  const MAXSPAN = 64, MAXSPAN_SEAT = 100;
  const FAM_TITLE = map({ seating: 'Guest seating', food: 'Food & buffet', bar: 'Bar', lounge: 'Lounge', cocktail: 'Cocktail tables', expo: 'Stalls & booths',
    service: 'Guest services', production: 'Production & AV', screen: 'Screens', bleacher: 'Bleachers', headtable: 'Head table', stage: 'Stage', dancefloor: 'Dance floor', aisle: 'Aisle walk' });
  const FAM_KEY = map({ food: 'dining' });
  const NOUN = map({ table: ['round table'], longtable: ['long table'], headtable: ['head table'], recttable: ['rectangular table'], cocktail: ['cocktail table'],
    seatblock: ['seat block'], chairrow: ['chair row'], chiavari: ['chair'], bench: ['bench', 'benches'], sofa: ['sofa'], loveseat: ['loveseat'], armchair: ['armchair'],
    couplesofa: ['couple sofa'], gaddi: ['gaddi'], bleacher: ['bleacher'], buffet: ['buffet counter'], livecounter: ['live counter'], caketable: ['cake table'],
    chocolatefountain: ['chocolate fountain'], truck: ['food truck'], dessert: ['dessert counter'], coffee: ['coffee counter'], bar: ['bar counter'], barstool: ['bar stool'],
    ledscreen: ['LED screen'], videowall: ['video wall'], led: ['LED screen'], projector: ['projector'], tvstand: ['TV stand'], photobooth: ['photo booth'], mandap: ['mandap'],
    chandelier: ['chandelier'], fountain: ['fountain'], floralarch: ['floral arch', 'floral arches'], piano: ['piano'], dj: ['DJ booth'], podium: ['podium'], lectern: ['lectern'],
    lounge: ['lounge'], kidszone: ['kids zone'], restroom: ['restroom'], coatcheck: ['coat check'], firstaid: ['first-aid point'], gifttable: ['gift table'], desk: ['desk'],
    booth: ['booth'], stall: ['stall'], kiosk: ['kiosk'], foh: ['FOH desk'], generator: ['generator'], stage: ['stage'], dancefloor: ['dance floor'], redcarpet: ['red carpet'],
    walkway: ['walkway'], selfieframe: ['selfie frame'], jhoola: ['jhoola'], entrancegate: ['entrance gate'], backdrop: ['backdrop'], brandwall: ['branding wall'],
    dais: ['dais', 'daises'], varmala: ['varmala stage'], viprisers: ['VIP riser'], greenroom: ['green room'], press: ['press area'], trophytable: ['trophy table'],
    chariot: ['chariot'], stagebackdrop: ['stage backdrop'], haldi: ['haldi corner'], mehendi: ['mehendi corner'], doli: ['doli'], altar: ['altar'], towerlight: ['tower light'],
    shoerack: ['shoe rack'], ticketbooth: ['ticket booth'], interpreter: ['interpreter booth'], watchtower: ['watch tower'], ambulance: ['ambulance'], plinth: ['plinth'], counter: ['counter'] });
  function noun(t, n) { const e = NOUN[t]; const one = e ? e[0] : String(t); return n === 1 ? one : (e && e[1]) || (/(s|x|ch|sh)$/.test(one) ? one + 'es' : one + 's'); }
  const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
  const famOf = (t) => FAMILY[t] || 'solo:' + t;
  function seatsOf(it) {
    const p = it.properties || {};
    if (p.rows && p.cols) return (+p.rows * +p.cols) || 0;
    if (p.seats) return +p.seats || 0;
    return it.type === 'chiavari' || it.type === 'barstool' ? 1 : 0;
  }

  // ---------------- normalised items ----------------
  function normItems(itemsIn, W, H) {
    const out = [], skipped = [], seen = Object.create(null);
    (Array.isArray(itemsIn) ? itemsIn : []).forEach((raw, i) => {
      if (!raw || typeof raw !== 'object') return;
      const type = raw.type == null ? '' : String(raw.type); if (!type) return;
      let id = raw.id != null ? String(raw.id) : type + '@' + i;
      if (seen[id]) { seen[id]++; id = id + '#' + seen[id]; } else seen[id] = 1;
      const w = Math.max(0, fnum(raw.width, 0)), h = Math.max(0, fnum(raw.height, 0)), x = fnum(raw.x, 0), y = fnum(raw.y, 0), rotation = fnum(raw.rotation, 0);
      const t = rotation * DEG, c = Math.cos(t), s = Math.sin(t);
      const ex = Math.abs(w / 2 * c) + Math.abs(h / 2 * s), ey = Math.abs(w / 2 * s) + Math.abs(h / 2 * c), cx = x + w / 2, cy = y + h / 2;
      const it = { raw, id, rid: raw.id != null ? raw.id : null, type, x, y, width: w, height: h, rotation, label: raw.label, properties: raw.properties || {},
        cx, cy, fp: { x0: cx - ex, y0: cy - ey, x1: cx + ex, y1: cy + ey }, area: w * h };
      const p = it.properties;
      if (!(w * h >= 0.25)) skipped.push({ id, why: 'zero size' });
      else if (raw.hidden || p.hidden) skipped.push({ id, why: 'hidden' });
      else if (it.fp.x1 <= 0 || it.fp.y1 <= 0 || it.fp.x0 >= W || it.fp.y0 >= H) skipped.push({ id, why: 'outside the hall' });
      else out.push(it);
    });
    return { items: out, skipped };
  }
  const fpGap = (a, b) => Math.hypot(Math.max(0, a.x0 - b.x1, b.x0 - a.x1), Math.max(0, a.y0 - b.y1, b.y0 - a.y1));
  const fpOver = (a, b) => Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
  const fpUnion = (a, b) => ({ x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) });
  const fpSpan = (b) => Math.max(b.x1 - b.x0, b.y1 - b.y0);
  const fpArea = (b) => (b.x1 - b.x0) * (b.y1 - b.y0);
  // uniform grid over layout-ft boxes: candidate pairs / neighbours without O(n^2)
  function boxGrid(list, boxOf, cell) {
    const m = new Map(), key = (i, j) => i * 73856093 ^ j * 19349663;
    list.forEach((o, n) => { const b = boxOf(o); for (let i = Math.floor(b.x0 / cell); i <= Math.floor(b.x1 / cell); i++) for (let j = Math.floor(b.y0 / cell); j <= Math.floor(b.y1 / cell); j++) {
      const k = key(i, j); let a = m.get(k); if (!a) m.set(k, a = []); a.push(n); } });
    const mark = new Int32Array(list.length); let stamp = 0;
    return { near(b, pad, fn) { const st = ++stamp;
      for (let i = Math.floor((b.x0 - pad) / cell); i <= Math.floor((b.x1 + pad) / cell); i++) for (let j = Math.floor((b.y0 - pad) / cell); j <= Math.floor((b.y1 + pad) / cell); j++) {
        const a = m.get(key(i, j)); if (a) for (const n of a) if (mark[n] !== st) { mark[n] = st; if (fn(list[n], n) === true) return; } } } };   // fn returns true = stop
  }

  // ---------------- solids (scene ft) ----------------
  /* Oriented boxes {id,type,x,z,hw,hd,c,s,R,y0,y1,roof} for collisions + line of sight. Floor items are 0.3 ft
     slabs (never block), hanging items float (free underneath), roofs are posts + a slab, the stage is a deck +
     its backdrop wall, a mandap is posts + plinth + canopy (see-through below). */
  function solidsOf(items, W, H, ringed) {
    const out = [];
    for (const it of items) {
      const X = it.cx - W / 2, Z = it.cy - H / 2, w = it.width, d = it.height, t = it.rotation * DEG, C = Math.cos(t), S = Math.sin(t), ty = it.type;
      const add = (ox, oz, hw, hd, y0, y1, roof) => out.push({ id: it.id, type: ty, x: X + ox * C - oz * S, z: Z + ox * S + oz * C, hw, hd, c: Math.cos(-t), s: Math.sin(-t), R: Math.hypot(hw, hd), y0, y1, roof: !!roof });
      const posts = (inset, half, y1) => { for (const [px, pz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) add(px * Math.max(0, w / 2 - inset), pz * Math.max(0, d / 2 - inset), half, half, 0, y1); };
      if (HANG[ty]) { add(0, 0, w / 2, d / 2, HANG[ty][0], HANG[ty][1]); continue; }
      if (ROOF[ty]) {   // matches builder-3d: tent / canopy roofs are 4-sided cones as wide as the LONGER side; the stage roof skin sits on 24 ft towers
        const top = topOf(ty), y0 = ty === 'stageroof' ? 23.4 : ty === 'umbrellas' ? 7.5 : 8;
        const cone = ty === 'tent' || ty === 'canopy', rh = cone ? 0.51 * Math.max(w, d) : w / 2, rd = cone ? 0.51 * Math.max(w, d) : d / 2;
        if (ty === 'umbrellas') posts(0, 0.1, 10.5); else posts(1, ty === 'stageroof' ? 0.6 : 0.3, y0 + 0.6);
        add(0, 0, rh, rd, y0, top, true); continue; }
      if (FLOOR[ty]) { add(0, 0, w / 2, d / 2, 0, 0.3); continue; }
      if (ty === 'stage') { add(0, 0, w / 2, d / 2, 0, 3); if (!it.properties.nobackdrop) add(0, -d / 2 + 0.5, w / 2, 0.5, 0, 3 + clamp(0.8 * d, 8, 14) + 2); continue; }
      if (ty === 'mandap') { posts(1.2, 0.6, 11); add(0, 0, w / 2, d / 2, 0, 1); add(0, 0, w / 2, d / 2, 10, 13); continue; }
      if (ty === 'lighting') { add(-(w / 2 - 0.5), 0, 0.5, Math.min(0.5, d / 2), 0, 17); add(w / 2 - 0.5, 0, 0.5, Math.min(0.5, d / 2), 0, 17); add(0, 0, w / 2, Math.min(0.5, d / 2), 14, 17); continue; }
      if (TABLES[ty] && (seatsOf(it) > 0 || (ringed && ringed.has(it.id)))) { add(0, 0, w / 2 + 2, d / 2 + 2, 0, 3.2); continue; }   // the ring of chairs round a seated table
      add(0, 0, w / 2, d / 2, 0, topOf(ty));
    }
    return out;
  }
  // spatial index over solids (16 ft cells); queries never scan the whole layout
  function solidIndex(solids) {
    const CELL = 16, m = new Map(), key = (i, j) => i * 73856093 ^ j * 19349663;
    solids.forEach((s, n) => { for (let i = Math.floor((s.x - s.R) / CELL); i <= Math.floor((s.x + s.R) / CELL); i++) for (let j = Math.floor((s.z - s.R) / CELL); j <= Math.floor((s.z + s.R) / CELL); j++) {
      const k = key(i, j); let a = m.get(k); if (!a) m.set(k, a = []); a.push(n); } });
    let stamp = 0; const mark = new Int32Array(solids.length);
    function each(x0, z0, x1, z1, fn) {
      const i0 = Math.floor(x0 / CELL), i1 = Math.floor(x1 / CELL), j0 = Math.floor(z0 / CELL), j1 = Math.floor(z1 / CELL);
      stamp++;
      if ((i1 - i0 + 1) * (j1 - j0 + 1) > 900) { for (let n = 0; n < solids.length; n++) if (fn(solids[n])) return true; return false; }
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) { const a = m.get(key(i, j)); if (!a) continue;
        for (const n of a) { if (mark[n] === stamp) continue; mark[n] = stamp; if (fn(solids[n])) return true; } }
      return false;
    }
    return { solids, each };
  }
  // segment a -> b vs one oriented box (slab test in the box's frame, then the height overlap)
  function segHit(a, b, s) {
    const dx = b[0] - a[0], dz = b[2] - a[2], L2 = dx * dx + dz * dz;
    let u = L2 > 1e-9 ? ((s.x - a[0]) * dx + (s.z - a[2]) * dz) / L2 : 0; u = u < 0 ? 0 : u > 1 ? 1 : u;
    const px = a[0] + dx * u - s.x, pz = a[2] + dz * u - s.z; if (px * px + pz * pz > s.R * s.R) return false;
    const la = [(a[0] - s.x) * s.c - (a[2] - s.z) * s.s, (a[0] - s.x) * s.s + (a[2] - s.z) * s.c];
    const lb = [(b[0] - s.x) * s.c - (b[2] - s.z) * s.s, (b[0] - s.x) * s.s + (b[2] - s.z) * s.c];
    let t0 = 0, t1 = 1;
    for (let k = 0; k < 2; k++) { const h = k ? s.hd : s.hw, p = la[k], q = lb[k] - la[k];
      if (Math.abs(q) < 1e-9) { if (p < -h || p > h) return false; continue; }
      let e0 = (-h - p) / q, e1 = (h - p) / q; if (e0 > e1) { const tmp = e0; e0 = e1; e1 = tmp; }
      t0 = Math.max(t0, e0); t1 = Math.min(t1, e1); if (t0 > t1) return false; }
    const y0 = a[1] + (b[1] - a[1]) * t0, y1 = a[1] + (b[1] - a[1]) * t1;
    return Math.min(y0, y1) < s.y1 && Math.max(y0, y1) > s.y0;
  }
  function segClear(a, b, idx, ignore) {
    return !idx.each(Math.min(a[0], b[0]) - 1, Math.min(a[2], b[2]) - 1, Math.max(a[0], b[0]) + 1, Math.max(a[2], b[2]) + 1,
      (s) => !(ignore && ignore.has(s.id)) && s.y1 > 0.35 && segHit(a, b, s));
  }
  /* A camera spot is OK when it is inside the hall (2 ft margin) and no solid is within 2 ft of it. A STANDING
     camera (eye height) is blocked by anything on the floor up to head height, but never by roofs / hanging
     decor above it; a raised (crane) camera is blocked only by what reaches its own height. */
  function camOK(p, idx, hw, hh, ignore, allowOut) {
    if (!p || !p.every(Number.isFinite)) return false;
    if (!allowOut && (Math.abs(p[0]) > hw - MARGIN || Math.abs(p[2]) > hh - MARGIN)) return false;
    if (p[1] < 1) return false;
    const standing = p[1] <= EYE + 0.6;
    return !idx.each(p[0] - CLEAR - 1, p[2] - CLEAR - 1, p[0] + CLEAR + 1, p[2] + CLEAR + 1, (s) => {
      if ((ignore && ignore.has(s.id)) || s.y1 <= 0.35) return false;
      if (s.roof && p[1] >= s.y0 - 1) { const dx = p[0] - s.x, dz = p[2] - s.z;   // never on / above a roof: it hides the view and traps the flight
        if (Math.abs(dx * s.c - dz * s.s) < s.hw + CLEAR && Math.abs(dx * s.s + dz * s.c) < s.hd + CLEAR) return true; }
      if (standing ? s.y0 >= p[1] + 0.75 : (s.y0 >= p[1] + 1 || s.y1 <= p[1] - 2)) return false;
      const dx = p[0] - s.x, dz = p[2] - s.z; if (dx * dx + dz * dz > (s.R + CLEAR) * (s.R + CLEAR)) return false;
      const lx = dx * s.c - dz * s.s, lz = dx * s.s + dz * s.c;
      return Math.abs(lx) < s.hw + CLEAR && Math.abs(lz) < s.hd + CLEAR;
    });
  }
  // the orbit guard at a stop: the camera may go anywhere above the floor except inside a solid
  function insideSolid(p, idx, pad, ignore) {
    const g = pad == null ? 0.5 : pad;
    return idx.each(p[0] - g - 1, p[2] - g - 1, p[0] + g + 1, p[2] + g + 1, (s) => {
      if ((ignore && ignore.has(s.id)) || s.y1 <= 0.35 || p[1] < s.y0 - g || p[1] > s.y1 + g) return false;
      const dx = p[0] - s.x, dz = p[2] - s.z, lx = dx * s.c - dz * s.s, lz = dx * s.s + dz * s.c;
      return Math.abs(lx) < s.hw + g && Math.abs(lz) < s.hd + g;
    });
  }
  // fraction of 3 rays (to the target and +-spread across the view) that reach it unobstructed
  function visibility(p, tgt, spread, idx, ignore) {
    const dx = tgt[0] - p[0], dz = tgt[2] - p[2], L = Math.hypot(dx, dz) || 1, sx = -dz / L * spread, sz = dx / L * spread;
    let ok = 0;
    for (const q of [tgt, [tgt[0] + sx, tgt[1], tgt[2] + sz], [tgt[0] - sx, tgt[1], tgt[2] - sz]]) if (segClear(p, q, idx, ignore)) ok++;
    return ok / 3;
  }

  // ---------------- framing ----------------
  // one vertical FOV for the whole walk: at least 42 deg across, even on a portrait phone
  function walkFov(aspect) {
    const a = num(aspect, 16 / 9) > 0.2 ? num(aspect, 16 / 9) : 16 / 9;
    return r2(clamp(2 * Math.atan(Math.tan(HMIN_FOV * DEG / 2) / a) / DEG, BASE_FOV, MAX_FOV));
  }
  function bandOf(b) {
    const B = b || DEFAULT_BAND, f = (v) => clamp(num(v, 0), 0, 0.45);
    return { t: f(B.t), b: f(B.b), l: f(B.l), r: f(B.r) };
  }
  function basis(az, el) {
    const dir = [Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)], f = [-dir[0], -dir[1], -dir[2]];
    let r = [-f[2], 0, f[0]]; const rl = Math.hypot(r[0], r[2]) || 1; r = [r[0] / rl, 0, r[2] / rl];
    const u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
    return { dir, f, r, u };
  }
  // NDC of world points for a camera at pos looking at target (three.js lookAt, up +y); z = depth
  function projectPts(pts, pos, target, fovDeg, aspect) {
    const f0 = sub(target, pos), fl = len(f0) || 1, f = f0.map((v) => v / fl);
    let r = [-f[2], 0, f[0]]; const rl = Math.hypot(r[0], r[2]); r = rl < 1e-9 ? [1, 0, 0] : [r[0] / rl, 0, r[2] / rl];
    const u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
    const tv = Math.tan(fovDeg * DEG / 2), th = tv * aspect;
    return pts.map((p) => { const q = sub(p, pos), z = q[0] * f[0] + q[1] * f[1] + q[2] * f[2];
      return { x: (q[0] * r[0] + q[2] * r[2]) / (z * th), y: (q[0] * u[0] + q[1] * u[1] + q[2] * u[2]) / (z * tv), z }; });
  }
  /* closed-form distance, then refine: pan so the projected box is centred in the CLEAR band and dolly so its
     binding axis spans `fill` of the band (frameBox's loop, generalised to a band) */
  function closedD(pts, c, B, o) {   // conservative closed-form distance (every point inside the band, no pan)
    const tanV = Math.tan(o.fov * DEG / 2), a = o.aspect, band = o.band, fx = o.fill * (1 - band.l - band.r), fy = o.fill * (1 - band.t - band.b);
    let d = o.dMin;
    for (const p0 of pts) { const p = sub(p0, c), pd = p[0] * B.dir[0] + p[1] * B.dir[1] + p[2] * B.dir[2];
      d = Math.max(d, pd + Math.abs(p[0] * B.r[0] + p[2] * B.r[2]) / (tanV * a * fx), pd + Math.abs(p[0] * B.u[0] + p[1] * B.u[1] + p[2] * B.u[2]) / (tanV * fy)); }
    return d;
  }
  function solveFrame(pts, c, B, o) {
    const tanV = Math.tan(o.fov * DEG / 2), a = o.aspect, band = o.band, fx = o.fill * (1 - band.l - band.r), fy = o.fill * (1 - band.t - band.b);
    let d = closedD(pts, c, B, o);
    const want = [band.l - band.r, band.b - band.t];
    let t = c.slice();
    const measure = () => {
      const pos = [t[0] + B.dir[0] * d, t[1] + B.dir[1] * d, t[2] + B.dir[2] * d];
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const p of pts) { const q = sub(p, pos), z = q[0] * B.f[0] + q[1] * B.f[1] + q[2] * B.f[2]; if (z < 0.5) return null;
        const nx = (q[0] * B.r[0] + q[2] * B.r[2]) / (z * tanV * a), ny = (q[0] * B.u[0] + q[1] * B.u[1] + q[2] * B.u[2]) / (z * tanV);
        if (nx < x0) x0 = nx; if (nx > x1) x1 = nx; if (ny < y0) y0 = ny; if (ny > y1) y1 = ny; }
      return { x0, x1, y0, y1, e: Math.max((x1 - x0) / 2 / fx, (y1 - y0) / 2 / fy), cx: (x0 + x1) / 2 - want[0], cy: (y0 + y1) / 2 - want[1] };
    };
    const pan = (m) => { t = [t[0] + B.r[0] * m.cx * d * tanV * a + B.u[0] * m.cy * d * tanV, t[1] + B.u[1] * m.cy * d * tanV, t[2] + B.r[2] * m.cx * d * tanV * a + B.u[2] * m.cy * d * tanV]; };
    for (let i = 0; i < 40; i++) {
      const m = measure(); if (!m) { d *= 1.4; continue; }
      if (Math.abs(m.cx) < 2e-3 && Math.abs(m.cy) < 2e-3 && (Math.abs(m.e - 1) < 2e-3 || (m.e < 1 && d <= o.dMin + 1e-6))) break;
      pan(m); d = Math.max(o.dMin, d * (1 + (m.e - 1) * 0.9));
    }
    // guarantee: everything inside the clear band (perspective on very deep boxes can defeat the refine)
    const lo = [-1 + 2 * band.l, -1 + 2 * band.b], hi = [1 - 2 * band.r, 1 - 2 * band.t];
    for (let i = 0; i < 40; i++) { const m = measure();
      if (m && m.x0 >= lo[0] && m.x1 <= hi[0] && m.y0 >= lo[1] && m.y1 <= hi[1]) break;
      if (m) pan(m); d *= 1.08; }
    d = Math.min(d, o.dMax);
    return { pos: [t[0] + B.dir[0] * d, t[1] + B.dir[1] * d, t[2] + B.dir[2] * d], target: t, d };
  }
  // same picture, sane orbit pivot: slide the look-at point along the view ray onto the subject's height
  function pivotTo(pos, target, yp) {
    const d = sub(target, pos), L = len(d) || 1, f = d.map((v) => v / L);
    if (f[1] > -1e-4) return target;                                    // level / up: nothing to slide
    if (pos[1] > yp + 1e-3) { const t = (pos[1] - yp) / -f[1]; if (t > 0.5 && t < 50 * L) return [pos[0] + f[0] * t, yp, pos[2] + f[2] * t]; }
    if (target[1] >= 0) return target;
    const t0 = pos[1] / -f[1]; return [pos[0] + f[0] * t0, 0, pos[2] + f[2] * t0];   // never a pivot underground
  }
  /* World points of one item: its rotated footprint (+pad) at its real height span (the live meshes via
     `bounds` when the 3D view is up; otherwise the shared height table). Seated tables include their chairs. */
  function itemPts(it, W, H, bounds) {
    let y0 = 0, y1 = topOf(it.type);
    if (HANG[it.type]) { y0 = HANG[it.type][0]; y1 = HANG[it.type][1]; }
    else if (it.type === 'stage') y1 = it.properties.nobackdrop ? 3 : 3 + clamp(0.8 * it.height, 8, 14) + 2;
    else if (FLOOR[it.type]) y1 = 0.3;
    const pad = TABLES[it.type] && seatsOf(it) > 0 ? 2.2 : 0.4, pts = [];
    let real = null; try { real = bounds ? bounds(it.rid) : null; } catch (_) { real = null; }
    if (real && real.min && real.max && [...real.min, ...real.max].every(Number.isFinite)) { y0 = Math.max(0, real.min[1]); y1 = Math.max(y0 + 0.3, real.max[1]);
      for (let i = 0; i < 8; i++) pts.push([i & 1 ? real.max[0] : real.min[0], i & 2 ? y1 : y0, i & 4 ? real.max[2] : real.min[2]]); }
    const X = it.cx - W / 2, Z = it.cy - H / 2;
    for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { const [ox, oz] = rot(sx * (it.width / 2 + pad), sz * (it.height / 2 + pad), it.rotation);
      pts.push([X + ox, y0, Z + oz], [X + ox, y1, Z + oz]); }
    return pts;
  }
  function boxOfPts(pts) {
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (const p of pts) { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; if (p[2] < z0) z0 = p[2]; if (p[2] > z1) z1 = p[2]; }
    return { min: [x0, y0, z0], max: [x1, y1, z1] };
  }
  const boxCorners = (b) => { const o = []; for (let i = 0; i < 8; i++) o.push([i & 1 ? b.max[0] : b.min[0], i & 2 ? b.max[1] : b.min[1], i & 4 ? b.max[2] : b.min[2]]); return o; };
  // tiny subjects are framed with some context around them (a chair is not a macro shot)
  function growMin(b) {
    const g = { min: b.min.slice(), max: b.max.slice() };
    for (const k of [0, 2]) { const need = 8 - (g.max[k] - g.min[k]); if (need > 0) { g.min[k] -= need / 2; g.max[k] += need / 2; } }
    const nh = 5 - (g.max[1] - g.min[1]); if (nh > 0) { g.min[1] = Math.max(0, g.min[1] - nh / 2); g.max[1] = g.min[1] + Math.max(5, b.max[1] - b.min[1]); }
    return g;
  }
  // candidate headings / elevations, cheapest first (rotate a little before craning a lot; "low" = under roofs)
  const CANDS = (() => { const out = [];
    for (const da of [0, 15, -15, 30, -30, 45, -45, 60, -60, 90, -90, 130, -130, 180]) for (const de of [0, 10, 20, 32, 'low', 'low2'])
      out.push({ da, de, base: Math.abs(da) / 90 + (de === 'low' ? 0.6 : de === 'low2' ? 0.7 : de / 40) });
    return out.sort((a, b) => a.base - b.base); })();
  /* placeCamera: the cheapest candidate whose camera is in the hall, clear of every solid, sees the subject
     with all 3 rays and frames it in the clear band. Never returns an unchecked spot: if nothing passes, the
     least-bad CHECKED candidate comes back flagged (the caller splits the group or marks it unproven). */
  function placeCamera(pts, ctx, o) {
    const bx = boxOfPts(pts), b = growMin(bx);
    const grown = [0, 1, 2].some((k) => b.max[k] - b.min[k] > bx.max[k] - bx.min[k] + 1e-6);
    const use = pts.length > 48 ? boxCorners(b) : grown ? boxCorners(b).concat(pts) : pts;
    const c = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
    const Rh = Math.hypot(b.max[0] - b.min[0], b.max[2] - b.min[2]) / 2, top = b.max[1];
    const el0 = o.kind === 'flat' ? 35 : o.kind === 'tall' ? 20 : 28;
    const spread = clamp(0.35 * Math.min(bx.max[0] - bx.min[0], bx.max[2] - bx.min[2]) / 2, 0.5, 3);   // side rays stay on the subject (a 4 ft carpet)
    const hw = ctx.W / 2, hh = ctx.H / 2, out = 0.15 * Math.max(ctx.W, ctx.H) + 6;
    let best = null, lowEl = null, bestOut = null, bestRoof = null, legFails = 0;
    for (const cd of CANDS) {
      const low = cd.de === 'low' || cd.de === 'low2', camY = cd.de === 'low2' ? 6.5 : EYE + 0.4;   // low2: a raised camera still under a tent roof
      if (low && lowEl == null) continue;
      let el = low ? lowEl : Math.min(el0 + cd.de, 62), s = null;   // up to a near top-down look (a carpet or a table in a packed hall)
      const az = o.heading + cd.da * DEG;
      if (!low && best) {   // cheap pre-check on the closed-form spot: skip the full solve where the camera clearly cannot stand
        const B0 = basis(az, el * DEG), d0 = closedD(use, c, B0, { aspect: ctx.aspect, fov: ctx.fov, band: ctx.band, fill: ctx.fill, dMin: Math.max(o.dMin || 8, (Rh + 3) / Math.cos(el * DEG)) });
        const q = [c[0] + B0.dir[0] * d0, c[1] + B0.dir[1] * d0, c[2] + B0.dir[2] * d0];
        const qIn = Math.abs(q[0]) <= hw + 4 && Math.abs(q[2]) <= hh + 4, qOut = q[1] >= 12 && Math.abs(q[0]) <= hw + out && Math.abs(q[2]) <= hh + out;
        if (!qIn && !qOut) continue;
        if (qIn && !camOK(q, ctx.idx, hw + 6, hh + 6, null, false) && !camOK([q[0] * 0.97, q[1], q[2] * 0.97], ctx.idx, hw + 6, hh + 6, null, false)) continue;
      }
      for (let it = 0; it < (low ? 3 : 1); it++) {   // "low": settle the elevation so the camera sits at eye height
        const B = basis(az, el * DEG), dMin = Math.max(o.dMin || 8, (Rh + 3) / Math.cos(el * DEG));
        s = solveFrame(use, c, B, { aspect: ctx.aspect, fov: ctx.fov, band: ctx.band, fill: ctx.fill, dMin, dMax: ctx.dMax });
        if (low) { const e2 = clamp(Math.asin(clamp((camY - s.target[1]) / Math.max(1, s.d), -1, 1)) / DEG, 3, cd.de === 'low2' ? 40 : 20); if (Math.abs(e2 - el) < 0.2) break; el = e2; }
      }
      if (lowEl == null && cd.de === 0 && cd.da === 0) lowEl = clamp(Math.asin(clamp((EYE + 0.4 - c[1]) / Math.max(1, s.d), -1, 1)) / DEG, 4, 15);
      const pos = s.pos.map(r2), inHall = Math.abs(pos[0]) <= hw - 1 && Math.abs(pos[2]) <= hh - 1;
      const outOK = !inHall && pos[1] >= 12 && Math.abs(pos[0]) <= hw + out && Math.abs(pos[2]) <= hh + out;
      let pen = cd.base;
      if (o.avoid && o.avoid.some((v) => close2(v, pos, s.target))) pen += 60;
      if (!pos.every(Number.isFinite) || pos[1] < EYE_MIN || (!inHall && !outOK)) pen += 100;
      else if (!camOK(pos, ctx.idx, hw, hh, null, outOK)) pen += 50;
      if (pen < 50) { if (outOK) pen += 3;
        const tgt = pivotTo(pos, s.target, clamp(c[1], 0, top));
        const rayT = o.kind === 'flat' ? [tgt[0], Math.max(tgt[1], bx.max[1] - 0.2), tgt[2]] : tgt;   // a floor item is seen by its top surface
        let vis = visibility(pos, rayT, spread, ctx.idx, o.ignore);
        if (vis === 1 && o.kind === 'flat') {   // ...and by its near edge, which tables / chairs in front would hide first
          const hx = pos[0] - c[0], hz = pos[2] - c[2], hl = Math.hypot(hx, hz) || 1, ex = (bx.max[0] - bx.min[0]) / 2 * 0.8, ez = (bx.max[2] - bx.min[2]) / 2 * 0.8;
          const k = Math.min(ex / Math.max(1e-6, Math.abs(hx / hl)), ez / Math.max(1e-6, Math.abs(hz / hl)));
          const q = [c[0] + hx / hl * k, rayT[1], c[2] + hz / hl * k];
          if (!insideSolid(q, ctx.idx, 0, o.ignore) && !segClear(pos, q, ctx.idx, o.ignore)) vis = 2 / 3; }
        if (vis === 1 && (Math.max(bx.max[0] - bx.min[0], bx.max[2] - bx.min[2]) > 14 || o.underRoof)) {   // and the far / near corners of the subject (a roof or a front row must not hide part of it)
          const ym = clamp((bx.min[1] + bx.max[1]) / 2, 0.3, Math.max(0.3, bx.max[1] - 0.2)), ix = (bx.max[0] - bx.min[0]) * 0.3, iz = (bx.max[2] - bx.min[2]) * 0.3;
          let blocked = 0;
          for (const [qx, qz] of [[bx.min[0] + ix, bx.min[2] + iz], [bx.max[0] - ix, bx.min[2] + iz], [bx.min[0] + ix, bx.max[2] - iz], [bx.max[0] - ix, bx.max[2] - iz]])
            if (!insideSolid([qx, ym, qz], ctx.idx, 0, o.ignore) && !segClear(pos, [qx, ym, qz], ctx.idx, o.ignore)) blocked++;   // a point buried in a neighbour is not "the subject"
          if (blocked >= 2) vis = 1 - blocked / 8; }   // one clipped corner is fine; two or more means a real part is hidden
        pen += 10 * (1 - vis);
        if (low && o.splittable) pen += 8;   // an eye-height shot of a whole block hides its back rows: split it instead
        if (o.legible && !o.legible(pos)) { pen += 8; legFails++; }   // too far to read: try another side before the group is split
        const cand = { pos, target: tgt, aim: rayT, d: s.d, el, az, vis, cost: pen, ok: vis === 1 && !outOK && pen < 8 };
        if (low && !o.splittable && vis >= 2 / 3 - 1e-9 && pen < 15 && !outOK && (!bestRoof || pen < bestRoof.cost)) bestRoof = cand;   // packed under a roof: most of it is the best there is
        if (vis === 1 && pen < 11 && outOK && (!bestOut || pen < bestOut.cost)) bestOut = cand;   // a crane shot from beyond a small hall's edge (no walls are drawn)
        if (!best || pen < best.cost) best = cand;
        if (cand.ok || clock() > ctx.deadline || (o.splittable && legFails >= 4)) break;   // a big group: splitting beats searching
      } else if (!best || pen < best.cost) best = { pos, target: pivotTo(pos, s.target, clamp(c[1], 0, top)), d: s.d, el, az, vis: 0, cost: pen, ok: false };
      if (best && clock() > ctx.deadline && cd.da === 0 && cd.de === 0) break;   // pathological layout: stay responsive, flag it
    }
    if (!best.ok && bestOut) { best = bestOut; best.ok = true; }
    if (!best.ok && bestRoof) { best = bestRoof; best.ok = true; best.partial = true; }
    best.box = b; best.c = c;
    return best;
  }
  const close2 = (v, pos, tgt) => Math.hypot(v.pos[0] - pos[0], v.pos[2] - pos[2]) < 6 && Math.hypot(v.target[0] - tgt[0], v.target[2] - tgt[2]) < 9;
  function pathKind(its) {
    const top = Math.max(...its.map((i) => (FLOOR[i.type] ? 0.3 : HANG[i.type] ? HANG[i.type][1] : topOf(i.type))));
    if (top < 1.2) return 'flat';
    const span = Math.max(...its.map((i) => Math.max(i.width, i.height)));
    return top > Math.max(8, span) ? 'tall' : 'normal';
  }

  // ---------------- entrance candidates ----------------
  /* Entry points a guest can arrive through, best first: security checkpoint → entrance arch / floral arch /
     entrance desk → exit marked as an entry → other exits → "Back centre" (the hall edge facing the stage). */
  const ENTRY_RX = /entr|entry|gate|arriv|welcome|reception/i;
  function stageFrame(items, W, H) {
    const stage = items.find((it) => it.type === 'stage');
    const sc = stage ? { x: stage.cx, y: stage.cy } : { x: W / 2, y: 0 };
    const front = stage ? rot(0, 1, stage.rotation) : [0, 1];             // from the stage toward the guests
    const right = [front[1], -front[0]];
    const where = (p) => {
      const rx = p.x - W / 2, ry = p.y - H / 2;
      const along = (rx * front[0] + ry * front[1]) / (Math.abs(front[0]) * W / 2 + Math.abs(front[1]) * H / 2 || 1);
      const side = (rx * right[0] + ry * right[1]) / (Math.abs(right[0]) * W / 2 + Math.abs(right[1]) * H / 2 || 1);
      const a = along > 0.33 ? 'back' : along < -0.33 ? 'front' : 'middle', b = side > 0.33 ? 'right' : side < -0.33 ? 'left' : 'centre';
      return a === 'middle' && b === 'centre' ? 'centre' : a === 'middle' ? b + ' side' : a + '-' + b;
    };
    return { stage, sc, front, where };
  }
  function entryCandidates(itemsIn, hall) { const { W, H } = hallOf(hall); return entryCands(normItems(itemsIn, W, H).items, W, H); }
  function entryCands(items, W, H) {
    const { stage, sc, front, where } = stageFrame(items, W, H);
    const out = [], seen = Object.create(null);
    const add = (it, rank, name) => { const id = it.rid != null ? String(it.rid) : it.type + '@' + Math.round(it.x) + ',' + Math.round(it.y);
      const uid = seen[id] ? id + '#' + (++seen[id]) : id; if (!seen[id]) seen[id] = 1;
      if (out.some((o) => o.item === it)) return;
      out.push({ id: uid, rank, label: name + ' (' + where({ x: it.cx, y: it.cy }) + ')', x: it.cx, y: it.cy, type: it.type, item: it }); };
    const lbl = (it) => String(it.label || '');
    items.filter((it) => it.type === 'checkpoint').forEach((it, i, a) => add(it, 0, 'Security check' + (a.length > 1 ? ' ' + (i + 1) : '')));
    items.filter((it) => it.type === 'arch' || it.type === 'floralarch' || it.type === 'entrancegate' || (it.type === 'desk' && ENTRY_RX.test(lbl(it))) || (it.type !== 'exit' && it.type !== 'stage' && /entr|gate/i.test(lbl(it))))
      .forEach((it) => add(it, 1, it.type === 'floralarch' ? 'Floral arch' : it.type === 'desk' ? 'Entrance desk' : it.type === 'arch' ? 'Entrance arch' : it.type === 'entrancegate' ? 'Entrance gate' : (lbl(it) || 'Entrance')));
    const exits = items.filter((it) => it.type === 'exit');
    exits.filter((it) => ENTRY_RX.test(lbl(it))).forEach((it) => add(it, 2, lbl(it) || 'Entry'));
    exits.forEach((it, i) => add(it, 3, 'Exit ' + (i + 1)));
    out.sort((a, b) => a.rank - b.rank);
    const bx = stage ? sc.x + front[0] * W : W / 2, by = stage ? sc.y + front[1] * H : H;
    out.push({ id: 'back-centre', rank: 4, label: 'Back centre', x: clamp(bx, 2, W - 2), y: clamp(by, 2, H - 2), type: 'edge', item: null });
    return out.map((c) => { const o = Object.assign({}, c); Object.defineProperty(o, 'item', { value: c.item, enumerable: false }); return o; });
  }

  // ---------------- overview ----------------
  /* Three-quarter view framing the hall floor box to `fill` of the viewport (presets + tests). The look-at
     point is slid along the view ray onto the floor so a drag orbits the venue, never a point underground. */
  function overviewView(hall, aspect, fovDeg, fill) {
    const { W, H } = hallOf(hall);
    const a = num(aspect, 16 / 9) > 0.2 ? num(aspect, 16 / 9) : 16 / 9, fov = num(fovDeg, OVERVIEW_FOV), f = num(fill, 0.8);
    const box = { min: [-W / 2, 0, -H / 2], max: [W / 2, 4, H / 2] };
    const CF = G.HelmCaptureFrame;
    let pos, target;
    if (CF && typeof CF.frameBox === 'function') { const fr = CF.frameBox(box, { aspect: a, fovDeg: fov, fill: f, elevationDeg: 40, azimuthDeg: 30, minDist: 20 }); pos = fr.position; target = fr.target; }
    else {
      const el = 40 * DEG, az = 30 * DEG, dir = [Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)];
      const tanV = Math.tan(fov * Math.PI / 360), R = Math.hypot(W, H) / 2, d = R / (Math.min(tanV, tanV * a) * f) * 0.6 + 4;
      target = [0, 0, 0]; pos = dir.map((v) => v * d);
    }
    target = pivotTo(pos, target, 0);
    return { pos: pos.map(r2), target: target.map(r2), fov };
  }
  // the walk's own overview: hall floor + every object (roofs included unless hidden), guests' side of the stage
  function overviewStop(ctx, items, which) {
    const hideRoofs = which === 'final' && items.some((i) => ROOF[i.type]);
    let b = { min: [-ctx.W / 2, 0, -ctx.H / 2], max: [ctx.W / 2, 4, ctx.H / 2] };
    for (const it of items) { if (hideRoofs && ROOF[it.type]) continue; const ib = ctx.box3 ? ctx.box3(it) : boxOfPts(itemPts(it, ctx.W, ctx.H, ctx.bounds));
      b = { min: [Math.min(b.min[0], ib.min[0]), 0, Math.min(b.min[2], ib.min[2])], max: [Math.max(b.max[0], ib.max[0]), Math.max(b.max[1], ib.max[1]), Math.max(b.max[2], ib.max[2])] }; }
    const fr = ctx.stageFront, baseAz = Math.atan2(fr[0], fr[1]) / DEG;   // camera on the guests' side
    let az = baseAz + (which === 'final' ? -35 : 30);
    const el = which === 'final' ? 52 : 40;
    if (ctx.aspect < 1) {   // portrait: run the hall's long axis into depth
      const opts = ctx.W >= ctx.H ? [70, 110, -70, -110] : [20, -20, 160, 200];
      az = opts.reduce((p, q) => (Math.abs(wrap((q - az) * DEG)) < Math.abs(wrap((p - az) * DEG)) ? q : p));
    }
    const B = basis(az * DEG, el * DEG), c = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
    const s = solveFrame(boxCorners(b), c, B, { aspect: ctx.aspect, fov: ctx.fov, band: ctx.band, fill: ctx.fill, dMin: 20, dMax: Infinity });
    const target = pivotTo(s.pos, s.target, 0);
    return { view: 'overview', fov: ctx.fov, pos: s.pos.map(r2), target: target.map(r2), hideRoofs, frame: { box: b, az: az * DEG, el, pivot: 0 }, d: s.d };
  }

  // overlap merge: subjects whose boxes overlap >= 50% of the smaller one are one place (one stop). A tight typed-array
  // loop in its own small function, so a hall packed with thousands of items never freezes the page.
  function mergeOverlaps(bx, ar, findI, ufa) {
      const NS = bx.length;
      const X0 = new Float64Array(NS), Y0 = new Float64Array(NS), X1 = new Float64Array(NS), Y1 = new Float64Array(NS);
      bx.forEach((b, i) => { X0[i] = b.x0; Y0[i] = b.y0; X1[i] = b.x1; Y1[i] = b.y1; });
      const CELL = 24, cells = new Map(), key = (i, j) => i * 100003 + j;
      for (let n = 0; n < NS; n++) for (let i = Math.floor(X0[n] / CELL); i <= Math.floor(X1[n] / CELL); i++) for (let j = Math.floor(Y0[n] / CELL); j <= Math.floor(Y1[n] / CELL); j++) {
        const k = key(i, j); let l = cells.get(k); if (!l) cells.set(k, l = []); l.push(n); }
      for (const l of cells.values()) {
        for (let p = 0; p < l.length; p++) { const a = l[p]; let budget = 150;
          for (let q = p + 1; q < l.length && budget > 0; q++) { const b = l[q];
            const ox = Math.min(X1[a], X1[b]) - Math.max(X0[a], X0[b]); if (ox <= 0) continue;
            const oy = Math.min(Y1[a], Y1[b]) - Math.max(Y0[a], Y0[b]); if (oy <= 0) continue;
            budget--; const m = ar[a] < ar[b] ? ar[a] : ar[b];
            if (m > 0 && ox * oy / m >= 0.5) { const ra = findI(a), rb = findI(b); if (ra !== rb) ufa[ra] = rb; } } } }
  }
  // ---------------- the planner ----------------
  function walkthroughStops(itemsIn, hall, opts) {
    const o = opts || {};
    const { W, H } = hallOf(hall);
    const aspect = num(o.aspect, 16 / 9) > 0.2 ? num(o.aspect, 16 / 9) : 16 / 9;
    const { items, skipped } = normItems(itemsIn, W, H);
    const byId = new Map(items.map((i) => [i.id, i]));
    // ---- 1. ownership: nested items belong to their host, chairs to their table, accessories to a neighbour ----
    const parent = new Map();
    const hosts = items.filter((i) => HOST[i.type]), hostGrid = boxGrid(hosts, (h) => h.fp, 24);
    const tables = items.filter((i) => TABLES[i.type]), tableGrid = boxGrid(tables, (h) => h.fp, 24);
    const solidsList = items.filter((i) => !ACCESSORY[i.type] && !ENVELOPE[i.type]), solidGrid = boxGrid(solidsList, (h) => h.fp, 24);
    const stages = items.filter((i) => i.type === 'stage');
    for (const it of items) {
      if (ENVELOPE[it.type]) continue;
      let best = null, budget = 400;
      hostGrid.near(it.fp, 0, (h) => { if (budget-- <= 0) return true; if (h === it || h.area <= it.area) return;
        if (fpOver(it.fp, h.fp) / Math.max(1e-6, fpArea(it.fp)) >= 0.6 && (!best || h.area < best.area)) best = h; });
      if (!best && it.type === 'chiavari') { let d0 = 3; tableGrid.near(it.fp, 3, (h) => { if (h.type === 'caketable') return; const d = fpGap(it.fp, h.fp); if (d <= d0) { d0 = d; best = h; } }); }
      if (!best && ACCESSORY[it.type]) { let d0 = 6; solidGrid.near(it.fp, 6, (h) => { if (h === it || MARKER[h.type]) return; const d = fpGap(it.fp, h.fp); if (d <= d0) { d0 = d; best = h; } }); }
      if (!best && SATELLITE[it.type]) for (const h of stages) if (fpGap(it.fp, h.fp) <= 25 && fpSpan(fpUnion(it.fp, h.fp)) <= Math.max(MAXSPAN, fpSpan(h.fp) * 1.15)) { best = h; break; }
      if (best) parent.set(it.id, best.id);
    }
    const root = (id) => { let r = id, n = 0; while (parent.has(r) && n++ < 64) r = parent.get(r); return r; };
    const kids = new Map();
    for (const it of items) { const r = root(it.id); if (r !== it.id) { if (!kids.has(r)) kids.set(r, []); kids.get(r).push(it.id); } }
    const ownBox = (id) => { let b = byId.get(id).fp; for (const k of kids.get(id) || []) b = fpUnion(b, byId.get(k).fp); return b; };
    // solids: a chair or centrepiece on a seated table is already inside the table's chair ring
    const ringed = new Set(); for (const it of items) { const pid = parent.get(it.id); if (pid && it.type === 'chiavari' && TABLES[byId.get(pid).type]) ringed.add(pid); }
    const solids = solidsOf(items.filter((i) => { const pid = parent.get(i.id), p = pid && byId.get(pid); return !(p && TABLES[p.type] && (i.type === 'chiavari' || ACCESSORY[i.type])); }), W, H, ringed), idx = solidIndex(solids);
    const sf = stageFrame(items, W, H);
    const ctx = { W, H, aspect, fov: num(o.fov, walkFov(aspect)), band: bandOf(o.band), fill: num(o.fill, FILL), idx, bounds: typeof o.bounds === 'function' ? o.bounds : null,
      dMax: Math.max(400, Math.max(W, H) * 2.6 + 60), stageFront: sf.front, deadline: clock() + num(o.budgetMs, 600) };
    const S = (x, y, h) => [r2(x - W / 2), r2(h), r2(y - H / 2)];
    const ptsCache = new Map(), boxCache = new Map();
    // under a tent / canopy the camera stays below the roof, so what pokes through it is framed up to the roof
    const roofs = solids.filter((x) => x.roof);
    const roofCap = (it) => { if (ROOF[it.type]) return Infinity; let cap = Infinity; const X = it.cx - W / 2, Z = it.cy - H / 2;
      for (const r of roofs) { const dx = X - r.x, dz = Z - r.z; if (Math.abs(dx * r.c - dz * r.s) <= r.hw && Math.abs(dx * r.s + dz * r.c) <= r.hd) cap = Math.min(cap, r.y0 - 0.3); } return cap; };
    const ptsOf = (it) => { let v = ptsCache.get(it.id); if (!v) { v = itemPts(it, W, H, ctx.bounds); const cap = roofCap(it); if (cap < Infinity) v = v.map((q) => [q[0], Math.min(q[1], cap), q[2]]); ptsCache.set(it.id, v); } return v; };
    const box3Of = ctx.box3 = (it) => { let v = boxCache.get(it.id); if (!v) { v = ptsCache.has(it.id) || ctx.bounds ? boxOfPts(ptsOf(it)) : quickBox(it); boxCache.set(it.id, v); } return v; };
    // the same box as boxOfPts(itemPts(...)) without building 16 points per item (the overview loops over every item)
    const quickBox = (it) => { let y0 = 0, y1 = topOf(it.type);
      if (HANG[it.type]) { y0 = HANG[it.type][0]; y1 = HANG[it.type][1]; } else if (it.type === 'stage') y1 = it.properties.nobackdrop ? 3 : 3 + clamp(0.8 * it.height, 8, 14) + 2; else if (FLOOR[it.type]) y1 = 0.3;
      const pad = TABLES[it.type] && seatsOf(it) > 0 ? 2.2 : 0.4, t = it.rotation * DEG, c = Math.abs(Math.cos(t)), sn = Math.abs(Math.sin(t));
      const ex = (it.width / 2 + pad) * c + (it.height / 2 + pad) * sn, ez = (it.width / 2 + pad) * sn + (it.height / 2 + pad) * c, X = it.cx - W / 2, Z = it.cy - H / 2, cap = roofCap(it);
      return { min: [X - ex, y0, Z - ez], max: [X + ex, Math.min(y1, cap < Infinity ? cap : y1), Z + ez] }; };
    const stops = [];
    const finish = () => { stops.rootOf = (id) => byId.get(root(id)); stops.skipped = skipped; stops.solids = solids; stops.index = idx; stops.items = items; stops.hall = { w: W, h: H }; stops.ctx = ctx; return stops; };


    // ---- 2. entrance (the chosen entry; it owns the entry item it stands in) ----
    const cands = entryCands(items, W, H), want = o.entry;
    const ent = cands.find((c) => c.id === want) || cands[0];
    const entItem = ent.item ? items.find((i) => i.raw === ent.item.raw) : null;
    const entOwn = entItem && !parent.has(entItem.id) ? [entItem.id, ...(kids.get(entItem.id) || [])] : [];
    const entSet = new Set(entOwn);

    // ---- 3. subjects: roots that are real things ----
    const isSubject = (it) => !parent.has(it.id) && !ACCESSORY[it.type] && !ENVELOPE[it.type] && !MARKER[it.type] && !entSet.has(it.id);
    const subjects = items.filter(isSubject);
    const overviewOwn = items.filter((it) => !parent.has(it.id) && !entSet.has(it.id) && !isSubject(it)).map((it) => it.id);

    if (!subjects.length) {   // empty (or markers / roofs only): one overview, nothing else to visit
      const ov = overviewStop(ctx, items, 'first');
      stops.push(Object.assign(ov, { key: 'overview', title: 'Venue overview', desc: items.length ? hallDesc(W, H, items.length) : `${Math.round(W)} × ${Math.round(H)} ft hall · add items to the layout to get a guided walkaround`,
        owns: overviewOwn.concat(entOwn), subject: [] }));
      return finish();
    }

    // ---- 4. groups: overlapping subjects merge (one place, one stop), then same-family clusters by gap ----
    const boxes = new Map(subjects.map((s) => [s.id, ownBox(s.id)]));
    const NS = subjects.length, ufa = new Int32Array(NS).map((_, i) => i), bx = subjects.map((x) => boxes.get(x.id)), ar = bx.map(fpArea);
    const findI = (x) => { while (ufa[x] !== x) { ufa[x] = ufa[ufa[x]]; x = ufa[x]; } return x; };
    mergeOverlaps(bx, ar, findI, ufa);   // (its own function: V8 optimizes small functions, not this big one)
    const rootOfS = new Map(subjects.map((x, i) => [x.id, i]));
    const find = (id) => subjects[findI(rootOfS.get(id))].id;
    let groups = new Map();
    for (const s of subjects) { const r = find(s.id); if (!groups.has(r)) groups.set(r, { subj: [], box: null, fam: null, big: null }); const g = groups.get(r);
      g.subj.push(s.id); g.box = g.box ? fpUnion(g.box, boxes.get(s.id)) : boxes.get(s.id); if (!g.big || s.area > g.big.area) g.big = s; }
    groups = [...groups.values()]; groups.forEach((g) => { g.fam = famOf(g.big.type); });
    // Kruskal single-link within a family: ascending gaps, merge while the union span stays under the cap
    { const n = groups.length, par = groups.map((_, i) => i), f2 = (x) => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
      const gb = groups.map((g) => g.box), edges = [], gg = boxGrid(groups.map((g, i) => i), (i) => gb[i], 40);
      for (let i = 0; i < n; i++) { const lim = MERGE_GAP[groups[i].fam] != null ? MERGE_GAP[groups[i].fam] : 12; if (lim <= 0) continue; let budget = 300;
        gg.near(gb[i], lim, (j) => { if (budget-- <= 0) return true; if (j <= i || groups[j].fam !== groups[i].fam) return; const g = fpGap(gb[i], gb[j]); if (g <= lim) edges.push([g, i, j]); }); }
      edges.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
      const cur = gb.slice();
      for (const [, i, j] of edges) { const a = f2(i), b = f2(j); if (a === b) continue; const u = fpUnion(cur[a], cur[b]);
        if (fpSpan(u) > (groups[i].fam === 'seating' ? MAXSPAN_SEAT : MAXSPAN)) continue; par[b] = a; cur[a] = u; }
      const merged = new Map();
      groups.forEach((g, i) => { const r = f2(i); if (!merged.has(r)) merged.set(r, { subj: [], box: cur[r], fam: g.fam }); merged.get(r).subj.push(...g.subj); });
      groups = [...merged.values()]; }

    // ---- 5. frame each group (split when it cannot be framed legibly) ----
    const center = { x: W / 2, y: H / 2 };
    const ownedBy = (subj) => subj.flatMap((k) => [k, ...(kids.get(k) || [])]);
    const legible = (pos, its) => its.every((i) => Math.hypot(i.cx - W / 2 - pos[0], (FLOOR[i.type] ? 0 : topOf(i.type) / 2) - pos[1], i.cy - H / 2 - pos[2]) <= readLimit(i, byId.get(root(i.id))) - (TABLES[i.type] ? 7 : 0));
    function headingFor(g, its) {
      const subj = g.subj.map((k) => byId.get(k)), lead = subj.slice().sort((a, b) => b.area - a.area)[0];
      const gx = (g.box.x0 + g.box.x1) / 2, gy = (g.box.y0 + g.box.y1) / 2;
      const st = subj.find((i) => i.type === 'stage');
      if (st) { const f = rot(0, 1, st.rotation); return Math.atan2(f[0], f[1]); }
      if (PATH[lead.type]) { const L = lead.height >= lead.width ? rot(0, 1, lead.rotation) : rot(1, 0, lead.rotation);
        let ax = L; if (sf.stage) { const toS = [sf.sc.x - gx, sf.sc.y - gy]; if (ax[0] * toS[0] + ax[1] * toS[1] > 0) ax = [-ax[0], -ax[1]]; }
        return Math.atan2(ax[0], ax[1]); }   // camera beyond the far end, looking along the carpet toward the stage
      if (FRONTED[lead.type] && subj.length <= 3) { const f = rot(0, 1, lead.rotation); return Math.atan2(f[0], f[1]); }
      let hx = center.x - gx, hy = center.y - gy;
      if (Math.hypot(hx, hy) < 0.15 * Math.min(W, H)) { hx = ent.x - gx; hy = ent.y - gy; }
      if (Math.hypot(hx, hy) < 1) { hx = sf.front[0]; hy = sf.front[1]; }
      const bw = g.box.x1 - g.box.x0, bh = g.box.y1 - g.box.y0;
      if (Math.max(bw, bh) >= 2.5 * Math.max(1, Math.min(bw, bh))) {   // long side square-on, on the hall-centre side
        if (bw >= bh) return Math.atan2(0, hy >= 0 ? 1 : -1); return Math.atan2(hx >= 0 ? 1 : -1, 0); }
      return Math.atan2(hx, hy);
    }
    const framed = [];
    function frameGroup(g, depth, sink, avoid) {
      sink = sink || framed;
      const ids = ownedBy(g.subj), its = ids.map((k) => byId.get(k)).filter((i) => !ENVELOPE[i.type]);
      let pts = [];
      if (its.length <= 6) for (const i of its) pts.push(...ptsOf(i));
      else { const bb = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
        for (const i of its) { const b = box3Of(i); for (let k = 0; k < 3; k++) { if (b.min[k] < bb.min[k]) bb.min[k] = b.min[k]; if (b.max[k] > bb.max[k]) bb.max[k] = b.max[k]; } }
        pts = boxCorners(bb); }
      const subjIts = g.subj.map((k) => byId.get(k));
      // legible distance: the subjects and what they hold; a chair is read with its table (7 ft of slack covers the ring / a chair pulled up 3 ft away)
      const readable = its.filter((i) => !ACCESSORY[i.type] && !(i.type === 'chiavari' && parent.has(i.id)));
      const best = placeCamera(pts, ctx, { kind: pathKind(subjIts), heading: headingFor(g, its), ignore: new Set(ids.filter((k) => !HANG[byId.get(k).type] || g.subj.includes(k))), avoid, underRoof: its.some((i) => roofCap(i) < Infinity), legible: (pos) => legible(pos, readable), splittable: g.subj.length > 1 && depth < 10 });
      const okLegible = legible(best.pos, readable);
      if ((!best.ok || !okLegible) && g.subj.length > 1 && depth < 10 && clock() <= ctx.deadline) {   // bisect along the long axis at the largest gap
        const ax = g.box.x1 - g.box.x0 >= g.box.y1 - g.box.y0 ? 'cx' : 'cy';
        // cut at a real gap (between rows / clusters); among the near-largest gaps take the one closest to the middle,
        // so a uniform grid halves instead of peeling one row at a time
        const ss = g.subj.slice().sort((p, q) => byId.get(p)[ax] - byId.get(q)[ax]), gaps = [];
        for (let i = 1; i < ss.length; i++) gaps.push(byId.get(ss[i])[ax] - byId.get(ss[i - 1])[ax]);
        const gm = Math.max(...gaps); let cut = 1, bestMid = Infinity;
        gaps.forEach((dd, k) => { if (dd >= 0.6 * gm - 1e-9) { const m = Math.abs(k + 1 - ss.length / 2); if (m < bestMid) { bestMid = m; cut = k + 1; } } });
        const mk = (sub) => { let b = boxes.get(sub[0]); sub.forEach((k) => { b = fpUnion(b, boxes.get(k)); }); return { subj: sub, box: b, fam: g.fam }; };
        frameGroup(mk(ss.slice(0, cut)), depth + 1, sink, avoid); frameGroup(mk(ss.slice(cut)), depth + 1, sink, avoid); return;
      }
      sink.push({ g, ids, best, unproven: !best.ok || !okLegible || undefined, why: !best.ok || !okLegible ? { vis: best.vis, cost: +best.cost.toFixed(2), legible: okLegible } : undefined });
    }
    // tiny venue (<= 50 ft): if the overview already frames every subject legibly, it is the whole tour
    const ov = overviewStop(ctx, items, 'first');
    const ovSees = (it) => { const P = projectPts(itemPts(it, W, H, ctx.bounds), ov.pos, ov.target, ctx.fov, aspect); return P.every((q) => q.z > 0.5 && Math.abs(q.x) <= 0.98 && Math.abs(q.y) <= 0.98) && legible(ov.pos, [it]); };
    if (Math.max(W, H) <= 50 && items.length <= 12 && subjects.every(ovSees)) {   // a small room: one view shows it all
      stops.push(Object.assign(ov, { key: 'overview', title: 'Venue overview', desc: hallDesc(W, H, items.length) + ' · everything fits in one view', owns: items.map((i) => i.id), subject: subjects.map((i) => i.rid) }));
      return finish();
    }
    groups.forEach((g) => frameGroup(g, 0));

    // ---- 6. near-duplicate stops merge (one camera pose shows both) ----
    // (if the merged group cannot be framed, the second stop is re-placed away from the first instead)
    const close = (a, b, dp, dt) => Math.hypot(a.pos[0] - b.pos[0], a.pos[2] - b.pos[2]) < dp && Math.hypot(a.target[0] - b.target[0], a.target[2] - b.target[2]) < dt;
    const tried = new Set();
    for (let guard = 0; guard < 2 * framed.length + 4 && clock() <= ctx.deadline; guard++) {
      let pair = null;
      for (let i = 0; i < framed.length && !pair; i++) for (let j = i + 1; j < framed.length; j++) {
        if (close(framed[i].best, framed[j].best, 8, 12) && !tried.has(framed[i].g.subj[0] + '|' + framed[j].g.subj[0])) { pair = [i, j]; break; } }
      if (!pair) break;
      const [i, j] = pair, a = framed[i], b = framed[j]; tried.add(a.g.subj[0] + '|' + b.g.subj[0]);
      const m = []; if (a.g.fam === b.g.fam) frameGroup({ subj: a.g.subj.concat(b.g.subj), box: fpUnion(a.g.box, b.g.box), fam: a.g.fam }, 10, m);   // a stage never swallows a table
      if (m.length === 1 && !m[0].unproven) { framed.splice(j, 1); framed[i] = m[0]; continue; }
      const r = []; frameGroup(b.g, 10, r, framed.filter((x) => x !== b && Math.hypot(x.best.pos[0] - b.best.pos[0], x.best.pos[2] - b.best.pos[2]) < 40).map((x) => x.best));
      if (r.length === 1 && !r[0].unproven) framed[j] = r[0];
    }

    // ---- 7. entrance camera: just inside the entry, eye level, looking (near-)level into the venue ----
    const look = sf.stage ? sf.sc : center;
    let entPos = null;
    { const dx = look.x - ent.x, dy = look.y - ent.y, L = Math.hypot(dx, dy) || 1, ux = dx / L, uy = dy / L, step = ent.type === 'edge' ? 0 : Math.min(6, L * 0.15);
      const ign = new Set(entOwn), tries = [];
      // near the entry first (a few steps in / along the wall), then a raised view right at the entry, and only
      // then deeper into the room - the entrance is the guest's first view, not a spot halfway down the hall
      for (const fwd of [step, step + 4]) for (const lat of [0, 5, -5, 10, -10, 15, -15]) tries.push([fwd, lat, EYE]);
      for (const h of [9, 12]) for (const lat of [0, 5, -5]) tries.push([step, lat, h]);
      for (const fwd of [step + 8, step + 14, step + 20]) for (const lat of [0, 5, -5, 10, -10, 15, -15, 25, -25]) tries.push([fwd, lat, EYE]);
      for (const [fwd, lat, hh] of tries) { const x = clamp(ent.x + ux * fwd - uy * lat, MARGIN + 0.1, W - MARGIN - 0.1), y = clamp(ent.y + uy * fwd + ux * lat, MARGIN + 0.1, H - MARGIN - 0.1);
        const p = S(x, y, hh); if (camOK(p, idx, W / 2, H / 2, ign)) { entPos = p; break; } }
      if (!entPos) for (const h of [14, 20]) { const p = S(clamp(ent.x + ux * step, MARGIN + 0.1, W - MARGIN - 0.1), clamp(ent.y + uy * step, MARGIN + 0.1, H - MARGIN - 0.1), h);
        if (camOK(p, idx, W / 2, H / 2, ign)) { entPos = p; break; } }
      if (!entPos) entPos = S(clamp(ent.x, MARGIN, W - MARGIN), clamp(ent.y, MARGIN, H - MARGIN), 24);   // checked above: 24 ft clears every standing object but tall roofs
    }
    const entTarget = (() => { const lx = look.x - W / 2, lz = look.y - H / 2, L = Math.hypot(lx - entPos[0], lz - entPos[2]) || 1;
      return [r2(lx), r2(entPos[1] - Math.max(0.6, 0.045 * L)), r2(lz)]; })();   // ~2.5 deg below level: inside the normal orbit limit

    // a zone stop must not repeat the entrance view: re-place it away from the entrance pose
    { const ev = { pos: entPos, target: entTarget };
      for (let i = 0; i < framed.length; i++) if (close(framed[i].best, ev, 8, 12)) { const r = []; frameGroup(framed[i].g, 10, r, [ev]); if (r.length === 1 && !r[0].unproven) framed[i] = r[0]; } }

    // ---- 8. route: entrance -> nearest neighbour -> 2-opt (open path, start fixed) ----
    const pts2 = [[entPos[0], entPos[2]], ...framed.map((f) => [f.best.pos[0], f.best.pos[2]])];
    const NP = pts2.length, DM = new Float64Array(NP * NP);
    for (let i = 0; i < NP; i++) for (let j = i + 1; j < NP; j++) DM[i * NP + j] = DM[j * NP + i] = Math.hypot(pts2[i][0] - pts2[j][0], pts2[i][1] - pts2[j][1]);
    const D = (i, j) => DM[i * NP + j];
    let order = [0]; { const left = new Set(pts2.map((_, i) => i).slice(1));
      while (left.size) { const l = order[order.length - 1]; let bj = -1, bd = Infinity; for (const j of left) { const d = D(l, j); if (d < bd - 1e-9 || (Math.abs(d - bd) < 1e-9 && j < bj)) { bd = d; bj = j; } } order.push(bj); left.delete(bj); } }
    for (let imp = true, guard = 0; imp && guard < 200; guard++) { imp = false;
      for (let i = 0; i < order.length - 2; i++) for (let k = i + 2; k < order.length; k++) {
        const a = order[i], b = order[i + 1], c = order[k], d = order[k + 1];
        if (D(a, c) + (d != null ? D(b, d) : 0) + 1e-6 < D(a, b) + (d != null ? D(c, d) : 0)) { for (let x = i + 1, y = k; x < y; x++, y--) { const t = order[x]; order[x] = order[y]; order[y] = t; } imp = true; } } }

    // ---- 9. assemble: overview → entrance → route → final overview (a different angle) ----
    stops.push(Object.assign(ov, { key: 'overview', title: 'Venue overview', desc: hallDesc(W, H, items.length), owns: overviewOwn, subject: [] }));
    const entDesc = ent.type === 'edge' ? 'Walking in from the hall entrance' + (sf.stage ? ' facing the stage' : '')
      : 'Arriving through the ' + ent.label.replace(/ \(.*\)$/, '').toLowerCase() + ' — the first view of the venue';
    const entD = len(sub(entTarget, entPos));
    stops.push({ key: 'entrance', title: 'Entrance', desc: entDesc, view: 'eye', fov: ctx.fov, pos: entPos, target: entTarget, entry: ent.id, owns: entOwn, subject: entOwn.map((k) => byId.get(k).rid),
      d: entD, minD: r2(Math.min(4, entD * 0.5)), maxD: r2(Math.max(60, entD * 1.6)) });
    const routed = order.slice(1).map((oi) => framed[oi - 1]);
    const titled = routed.map((f) => describe(f, byId, sf.where, kids, parent));
    const tcount = Object.create(null), keyN = Object.create(null);
    titled.forEach((t) => { tcount[t.title] = (tcount[t.title] || 0) + 1; });
    const seenT = Object.create(null);
    routed.forEach((f, n) => {
      const t = titled[n]; let title = t.title;
      if (tcount[t.title] > 1) { title = t.title + ' · ' + t.where; seenT[title] = (seenT[title] || 0) + 1; if (seenT[title] > 1) title += ' ' + seenT[title]; }
      const base = FAM_KEY[f.g.fam] || f.g.fam.replace(/^solo:/, ''); keyN[base] = (keyN[base] || 0) + 1;
      const b = f.best;
      stops.push({ key: keyN[base] > 1 ? base + '-' + keyN[base] : base, title, desc: t.desc, view: 'frame', fov: ctx.fov, pos: b.pos.map(r2), target: b.target.map(r2),
        aim: (b.aim || b.target).map(r2), partial: b.partial || undefined, owns: f.ids, subject: f.g.subj.map((k) => byId.get(k).rid), guests: t.guests, unproven: f.unproven, why: f.why,
        frame: { box: b.box, az: b.az, el: b.el, pivot: clamp(b.c[1], 0, b.box.max[1]) }, d: len(sub(b.target, b.pos)), minD: r2(Math.min(0.9 * len(sub(b.target, b.pos)), Math.max(4, 0.4 * len(sub(b.target, b.pos))))), maxD: r2(Math.max(2 * len(sub(b.target, b.pos)), 60)) });
    });
    const fin = overviewStop(ctx, items, 'final');
    stops.push(Object.assign(fin, { key: 'final', title: fin.hideRoofs ? 'Inside view' : 'Final overview',
      desc: fin.hideRoofs ? 'Roofs lifted so you can see everything under them — drag to look around' : 'That’s the whole venue — drag to look around', owns: [], subject: [] }));
    return finish();
  }
  // legible distance: 5x the item's size (min 85 ft); a nested item (podium on a stage) is read with its host
  const readLimit = (it, host) => Math.max(85, 5 * Math.max(it.width, it.height), host ? 5 * Math.max(host.width, host.height) : 0);
  function hallDesc(W, H, n) { return `${Math.round(W)} × ${Math.round(H)} ft hall · ${plural(n, 'item')} in the layout`; }
  // count-first caption: "12 round tables · 120 guests", "60 × 20 ft stage · mandap · 2 LED screens"
  function describe(f, byId, where, kids, parent) {
    const subj = f.g.subj.map((k) => byId.get(k)), lead = subj.slice().sort((a, b) => b.area - a.area)[0];
    const onTable = (i) => i.type === 'chiavari' && parent.has(i.id) && !!TABLES[byId.get(parent.get(i.id)).type];
    let guests = 0;
    for (const it of subj) {
      if (it.type === 'chiavari') { guests += 1; continue; }
      if (!TABLES[it.type] && !SEATS[it.type]) continue;
      const own = seatsOf(it), chairs = (kids.get(it.id) || []).filter((k) => onTable(byId.get(k))).length;
      guests += own > 0 ? own : chairs;
    }
    const counts = new Map();
    for (const i of f.ids.map((k) => byId.get(k))) if (!ACCESSORY[i.type] && !onTable(i)) counts.set(i.type, (counts.get(i.type) || 0) + 1);
    const parts = [];
    if (lead.type === 'stage' || lead.type === 'dancefloor' || PATH[lead.type]) {
      parts.push(PATH[lead.type] ? `${Math.round(Math.max(lead.width, lead.height))} ft ${noun(lead.type, 1)}` : `${Math.round(lead.width)} × ${Math.round(lead.height)} ft ${noun(lead.type, 1)}`);
      counts.set(lead.type, counts.get(lead.type) - 1);
    }
    const rest = [...counts.entries()].filter((e) => e[1] > 0).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    for (const [t, n] of rest) parts.push(n === 1 && parts.length ? noun(t, 1) : n + ' ' + noun(t, n));
    if (guests > 0) parts.push(plural(guests, 'guest'));
    let title = FAM_TITLE[f.g.fam] || cap(noun(lead.type, subj.filter((i) => i.type === lead.type).length > 1 ? 2 : 1));
    if (lead.type === 'stage') { const l = String(lead.label || '').trim(); title = l && !/^(main\s+)?stage$/i.test(l) ? l : 'Main stage'; }
    return { title, desc: parts.join(' · ') || cap(noun(lead.type, 1)), guests, where: where({ x: (f.g.box.x0 + f.g.box.x1) / 2, y: (f.g.box.y0 + f.g.box.y1) / 2 }) };
  }

  // ---------------- coverage proof ----------------
  /* Every kept item is owned by exactly one stop; every non-accessory item is framed (6 of its 8 box corners
     on screen, legible distance) by its OWN stop, except the entry item (you stand in it) and what the
     overview owns; no stop is unproven; no two stops share a camera pose; no camera is inside a solid; the
     route between the eye stops never crosses itself. */
  function proveCoverage(stops, opts) {
    const o = opts || {}, items = stops.items || [], idx = stops.index, hall = stops.hall, errors = [];
    const aspect = num(o.aspect, stops.ctx ? stops.ctx.aspect : 16 / 9), owner = new Map();
    for (const s of stops) for (const id of s.owns || []) { if (owner.has(id)) errors.push('double-owned ' + id + ' by ' + owner.get(id).key + ' and ' + s.key); else owner.set(id, s); }
    for (const it of items) {
      const s = owner.get(it.id); if (!s) { errors.push('unowned ' + it.id + ' (' + it.type + ')'); continue; }
      if (s.view === 'overview' || ACCESSORY[it.type] || (s.key === 'entrance' && s.entry != null)) continue;
      const P = projectPts(itemPts(it, hall.w, hall.h, null), s.pos, s.target, s.fov, aspect);
      const inside = P.filter((q) => q.z > 0.5 && Math.abs(q.x) <= 1 && Math.abs(q.y) <= 1).length;
      const c = [it.cx - hall.w / 2, topOf(it.type) / 2, it.cy - hall.h / 2];
      if (inside < 6) errors.push('not framed by its stop: ' + it.id + ' (' + it.type + ') @ ' + s.key + ' corners ' + inside + '/8');
      else if (len(sub(c, s.pos)) > readLimit(it, stops.rootOf ? stops.rootOf(it.id) : null) + 1) errors.push('too far to read: ' + it.id + ' @ ' + s.key);
    }
    for (const s of stops) {
      if (s.unproven) errors.push('unproven stop ' + s.key);
      if (![...s.pos, ...s.target, s.fov].every(Number.isFinite)) errors.push('non-finite stop ' + s.key);
      if (s.view !== 'overview' && idx && !camOK(s.pos, idx, hall.w / 2, hall.h / 2, s.key === 'entrance' ? new Set(s.owns) : null, s.pos[1] >= 12)) errors.push('camera blocked at ' + s.key);
    }
    const eye = stops.filter((s) => s.view !== 'overview');
    for (let i = 0; i < eye.length; i++) for (let j = i + 1; j < eye.length; j++) {
      const a = eye[i], b = eye[j];
      if (Math.hypot(a.pos[0] - b.pos[0], a.pos[2] - b.pos[2]) < 4 && Math.hypot(a.target[0] - b.target[0], a.target[2] - b.target[2]) < 6) errors.push('near-duplicate stops ' + a.key + ' ~ ' + b.key);
    }
    const crossings = routeCrossings(eye.map((s) => [s.pos[0], s.pos[2]]));
    if (crossings) errors.push('route crosses itself ' + crossings + 'x');
    return { ok: errors.length === 0, errors, owned: owner.size, items: items.length, skipped: (stops.skipped || []).length, crossings };
  }
  function routeCrossings(pts) {
    const o = (p, q, r) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
    let n = 0;
    for (let i = 0; i + 1 < pts.length; i++) for (let j = i + 2; j + 1 < pts.length; j++) {
      const a = pts[i], b = pts[i + 1], c = pts[j], d = pts[j + 1];
      if (o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0) n++; }
    return n;
  }
  // re-solve one stop for another aspect / band (resize, rotate, fullscreen, photo render)
  function resolveStop(stop, opts) {
    if (!stop) return null;
    if (!stop.frame) return { pos: stop.pos.slice(), target: stop.target.slice(), fov: stop.fov };
    const a = num(opts && opts.aspect, 16 / 9) > 0.2 ? num(opts && opts.aspect, 16 / 9) : 16 / 9, fov = num(opts && opts.fov, walkFov(a)), band = bandOf(opts && opts.band);
    const b = stop.frame.box, B = basis(stop.frame.az, stop.frame.el * DEG), c = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
    const Rh = Math.hypot(b.max[0] - b.min[0], b.max[2] - b.min[2]) / 2;
    const dMin = stop.view === 'overview' ? 20 : Math.max(8, (Rh + 3) / Math.cos(stop.frame.el * DEG));
    const s = solveFrame(boxCorners(b), c, B, { aspect: a, fov, band, fill: FILL, dMin, dMax: Infinity });
    return { pos: s.pos.map(r2), target: pivotTo(s.pos, s.target, num(stop.frame.pivot, 0)).map(r2), fov };
  }

  // ---------------- motion ----------------
  const smoother = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * t * (t * (t * 6 - 15) + 10));   // C2: no jerk, peak 1.875x
  const ease = smoother;
  // Hermite ease that starts at normalised speed v0 (retarget mid-flight without a velocity kink)
  const easeFrom = (v0) => (v0 > 1e-3 ? (t) => (t <= 0 ? 0 : t >= 1 ? 1 : v0 * (t - 2 * t * t + t * t * t) + (3 * t * t - 2 * t * t * t)) : smoother);
  function heading(v) {
    const d = sub(v.target, v.pos), h = Math.hypot(d[0], d[2]);
    return { yaw: h > 1e-6 ? Math.atan2(d[0], d[2]) : 0, pitch: Math.atan2(d[1], h), dist: Math.max(1, len(d)) };
  }
  // flight path for the eye: straight if clear, else a lifted hop, a sideways detour, or over the top
  function planPath(a, b, idx, hall, ignore) {
    const bez = (P) => (t) => { const u = 1 - t;
      if (P.length === 2) return lerp3(P[0], P[1], t);
      if (P.length === 3) return [0, 1, 2].map((k) => u * u * P[0][k] + 2 * u * t * P[1][k] + t * t * P[2][k]);
      return [0, 1, 2].map((k) => u * u * u * P[0][k] + 3 * u * u * t * P[1][k] + 3 * u * t * t * P[2][k] + t * t * t * P[3][k]); };
    const N = 24, clear = (P) => { if (!idx) return true; const f = bez(P); let prev = f(0);
      for (let i = 1; i <= N; i++) { const q = f(i / N); q[1] = Math.max(q[1], Math.min(EYE_MIN, a[1], b[1])); if (!segClear(prev, q, idx, ignore)) return false; prev = q; } return true; };
    const mk = (kind, P) => ({ kind, P, at: bez(P) });
    if (clear([a, b])) return mk('direct', [a, b]);
    const m = lerp3(a, b, 0.5), hi = Math.max(a[1], b[1]);
    for (const lift of [8, 14, 22, 32]) { const q = [m[0], hi + lift, m[2]]; if (clear([a, q, b])) return mk('hop', [a, q, b]); }
    const dx = b[0] - a[0], dz = b[2] - a[2], L = Math.hypot(dx, dz) || 1;
    for (let k = 1; k <= 8; k++) for (const sg of [1, -1]) {
      const w = [m[0] - dz / L * k * 6 * sg, Math.max(hi, EYE), m[2] + dx / L * k * 6 * sg], q = [2 * w[0] - m[0], w[1], 2 * w[2] - m[2]];
      if ((!hall || (Math.abs(w[0]) < hall.w / 2 - MARGIN && Math.abs(w[2]) < hall.h / 2 - MARGIN)) && clear([a, q, b])) return mk('detour', [a, q, b]); }
    for (const low of [EYE + 0.5, EYE_MIN + 0.5]) {   // under a roof: duck to eye height for the crossing
      const p1 = lerp3(a, b, 0.33), p2 = lerp3(a, b, 0.67); p1[1] = low; p2[1] = low;
      if (clear([a, p1, p2, b])) return mk('duck', [a, p1, p2, b]);
      // leave / enter a roofed area at eye height, climbing only once clear of it (or dropping in from outside)
      if (clear([a, p1, [b[0], low, b[2]], b])) return mk('duck', [a, p1, [b[0], low, b[2]], b]);
      if (clear([a, [a[0], low, a[2]], p2, b])) return mk('duck', [a, [a[0], low, a[2]], p2, b]);
      for (let k = 1; k <= 6; k++) for (const sg of [1, -1]) { const ox = -dz / L * k * 8 * sg, oz = dx / L * k * 8 * sg;
        const q1 = [p1[0] + ox, low, p1[2] + oz], q2 = [p2[0] + ox, low, p2[2] + oz];
        if (clear([a, q1, q2, b])) return mk('duck', [a, q1, q2, b]); } }
    const top = Math.max(40, hi + 30);
    return mk('overhead', [a, [a[0], top, a[2]], [b[0], top, b[2]], b]);
  }
  /* Plan one flight from the live view to a stop. The eye follows the planned path at a uniform speed eased
     by smootherstep; the head turns the short way round with a clamped pitch; the look distance changes in
     log space; it lands exactly on the stop. */
  function planFlight(from, to, opts) {
    const o = opts || {}, ha = heading(from), hb = heading(to), dYaw = wrap(hb.yaw - ha.yaw);
    const path = o.path || planPath(from.pos, to.pos, o.index || null, o.hall || null, o.ignore || null);
    const N = 32, lut = [0]; let prev = path.at(0), L = 0;
    for (let i = 1; i <= N; i++) { const q = path.at(i / N); L += len(sub(q, prev)); lut.push(L); prev = q; }
    const vert = Math.abs(to.pos[1] - from.pos[1]);
    const ms = o.reduced ? 0 : o.ms != null ? o.ms : Math.round(clamp(Math.max(MIN_MS, L / LIN_FTPS * 1000, Math.abs(dYaw) / DEG / ANG_DPS * 1000, vert / 18 * 1000), MIN_MS, MAX_MS));
    const pLo = Math.min(PITCH_MIN, ha.pitch, hb.pitch), pHi = Math.max(PITCH_MAX, ha.pitch, hb.pitch);
    const floorY = Math.min(EYE_MIN, from.pos[1], to.pos[1]);
    return { from, to, ha, hb, dYaw, path, L, lut, ms, floorY, pLo, pHi, ease: o.v0 ? easeFrom(o.v0) : smoother };
  }
  function viewAt(P, k) {
    if (k >= 1) return { pos: P.to.pos.slice(), target: P.to.target.slice(), fov: num(P.to.fov, num(P.from.fov, WALK_FOV)) };
    const e = P.ease(clamp(k, 0, 1)), r = smoother(clamp(k, 0, 1));
    // arc-length parameter -> curve parameter
    const want = e * P.L; let i = 1; while (i < P.lut.length - 1 && P.lut[i] < want) i++;
    const seg = P.lut[i] - P.lut[i - 1], u = ((i - 1) + (seg > 1e-9 ? (want - P.lut[i - 1]) / seg : 0)) / (P.lut.length - 1);
    const pos = P.path.at(clamp(u, 0, 1)); pos[1] = Math.max(P.floorY, pos[1]);
    const yaw = P.ha.yaw + P.dYaw * r, pitch = clamp(P.ha.pitch + (P.hb.pitch - P.ha.pitch) * r, P.pLo, P.pHi);
    const dist = Math.exp(Math.log(P.ha.dist) + (Math.log(P.hb.dist) - Math.log(P.ha.dist)) * r), c = Math.cos(pitch);
    const target = [pos[0] + Math.sin(yaw) * c * dist, pos[1] + Math.sin(pitch) * dist, pos[2] + Math.cos(yaw) * c * dist];
    const f0 = num(P.from.fov, WALK_FOV), f1 = num(P.to.fov, f0);
    return { pos, target, fov: f0 + (f1 - f0) * r };
  }
  // back-compat helper (tests / tools): the view at progress k of a direct flight between two views
  function tweenView(from, to, k) { return viewAt(planFlight(from, to, { ms: 1000 }), k); }
  function flightMs(reduced, dist) {
    if (reduced) return 0;
    if (!(dist > 0)) return MIN_MS;
    return Math.round(clamp(dist / LIN_FTPS * 1000, MIN_MS, MAX_MS));
  }
  const travel = (from, to) => (from && to ? len(sub(to.pos, from.pos)) : 0);
  /* One flight on a PAUSABLE clock built from frame deltas (a hidden tab or a stalled frame never makes it
     jump: each frame advances at most 150 ms; a slow device still flies in real time down to ~7 fps). apply(view) per frame, done() once on landing; cancel() stops it
     without done(); velocity() = the eye's current speed (ft/ms) so the next flight can start at that speed. */
  function createFlight(o) {
    const raf = o.raf, caf = o.caf, now = o.now;
    const P = o.plan || planFlight(o.from || o.to, o.to, { ms: o.ms != null ? o.ms : undefined, reduced: o.ms === 0 });
    const ms = P.ms;
    let id = null, dead = false, paused = false, elapsed = 0, last = now(), lastPos = null, vel = [0, 0, 0];
    const finish = () => { if (dead) return; dead = true; id = null; o.apply(viewAt(P, 1)); if (o.done) o.done(); };
    if (!(ms > 0) || !o.from) { finish(); return { cancel() {}, pause() {}, resume() {}, velocity: () => [0, 0, 0], get active() { return false; }, plan: P }; }
    const step = () => {
      if (dead) return; const t = now();
      if (!paused) elapsed += Math.min(Math.max(0, t - last), 150);
      const dt = t - last; last = t;
      const k = Math.min(1, elapsed / ms);
      if (k >= 1) { finish(); return; }
      const v = viewAt(P, k);
      if (lastPos && dt > 0) vel = sub(v.pos, lastPos).map((x) => x / dt);
      lastPos = v.pos; o.apply(v); id = raf(step);
    };
    id = raf(step);
    return { plan: P,
      cancel() { dead = true; if (id != null) caf(id); id = null; },
      pause() { paused = true; }, resume() { last = now(); paused = false; },
      velocity: () => vel.slice(), get active() { return !dead; } };
  }
  // rapid-key gate (key auto-repeat): allow() is true at most once per `ms`
  function makeGate(ms, now) { let last = -Infinity; return { allow() { const t = now(); if (t - last < ms) return false; last = t; return true; }, reset() { last = -Infinity; } }; }
  // auto-play dwell: longer captions stay up longer; overviews 5 s
  function dwellMs(stop) {
    if (!stop) return DWELL_MS;
    if (stop.view === 'overview') return 5000;
    return Math.round(clamp(3500 + 35 * (String(stop.title || '').length + String(stop.desc || '').length), 3500, 8000));
  }
  // label sprites: shown at overview stops, hidden at eye level (the subject's own tags stay); a user toggle wins
  function stopShowsLabels(stop, override) {
    if (override === true || override === false) return override;
    return !!(stop && stop.view === 'overview');
  }
  /* Keys during the tour. Navigation: → / PageDown next, ← / PageUp previous, Home / End first / last,
     Space / K play-pause, Esc close-the-list-then-exit. Everything that would EDIT the layout (arrows that
     nudge, Delete / Backspace, r / d / g / t / y, Cmd/Ctrl + D / V / X / Z / Y / A) is swallowed ('block'). */
  function walkKey(key, mods) {
    const m = mods || {}, mod = !!(m.metaKey || m.ctrlKey);
    if (mod) { const k = String(key || '').toLowerCase(); return 'dvxzya'.indexOf(k) >= 0 && k.length === 1 ? 'block' : null; }
    if (key === 'ArrowRight' || key === 'PageDown') return 'next';
    if (key === 'ArrowLeft' || key === 'PageUp') return 'prev';
    if (key === 'Home') return 'first';
    if (key === 'End') return 'last';
    if (key === ' ' || key === 'k' || key === 'K' || key === 'p' || key === 'P') return 'toggle';
    if (key === 'Escape') return 'exit';
    if (key === 'ArrowUp' || key === 'ArrowDown' || key === 'Delete' || key === 'Backspace' || /^[rdgtyRDGTY]$/.test(String(key))) return 'block';
    return null;
  }

  function eveningLightPoints(items, hall) {
    const W = num(hall && hall.w, 200), H = num(hall && hall.h, 140);
    const pts = [];
    const add = (it, y, k, r) => { pts.push({ x: num(it.x, 0) + num(it.width, 0) / 2 - W / 2, y, z: num(it.y, 0) + num(it.height, 0) / 2 - H / 2, k, r }); };
    (items || []).filter((i) => i && i.type === 'stage').slice(0, 2).forEach((s) => add(s, 18, 2.2, 90));
    (items || []).filter((i) => i && (i.type === 'dancefloor' || i.type === 'bar' || i.type === 'chandelier')).slice(0, 3).forEach((s) => add(s, 14, 1.4, 60));
    const tables = (items || []).filter((i) => i && (i.type === 'table' || i.type === 'longtable' || i.type === 'headtable'));
    const step = Math.max(1, Math.ceil(tables.length / 4));
    for (let i = 0; i < tables.length && pts.length < 8; i += step) add(tables[i], 10, 0.9, 40);
    if (!pts.length) pts.push({ x: 0, y: 20, z: 0, k: 1.4, r: Math.max(W, H) });
    return pts.slice(0, 8);
  }
  // r20 (live QA): the top-down camera frames the whole hall in the CLEAR band between the Move / Rotate /
  // Scale bar and the hint bar, like the 2D plan. Without a view: the old fixed height.
  const topDown = (hall, view) => {
    const HW = Math.max(10, num(hall && hall.w, 200)), HD = Math.max(10, num(hall && hall.h, 140));
    if (!view) { const R = Math.max(HW, HD); return { pos: [0, +(R * 1.05).toFixed(2), 0.01], target: [0, 0, 0] }; }
    const a = num(view.aspect, 16 / 9) > 0.2 ? num(view.aspect, 16 / 9) : 16 / 9, fov = num(view.fovDeg, OVERVIEW_FOV);
    const cl = (v) => Math.min(0.4, Math.max(0, num(v, 0)));
    const top = cl(view.top), bot = cl(view.bottom), side = cl(view.side), m = 1.06;   // 6% breathing room
    const tanV = Math.tan(fov * Math.PI / 360);
    const d = Math.max(HD * m / (2 * tanV * (1 - top - bot)), HW * m / (2 * tanV * a * (1 - 2 * side)), 20);
    const shift = (top - bot) * d * tanV;
    return { pos: [0, r2(d), r2(-shift + 0.01)], target: [0, 0, r2(-shift)] };
  };
  // convenience for tests / tools: solids + index for a raw layout
  function solidsFor(itemsIn, hall) { const { W, H } = hallOf(hall), items = normItems(itemsIn, W, H).items, s = solidsOf(items, W, H); return { solids: s, index: solidIndex(s), W, H }; }

  const API = { walkthroughStops, proveCoverage, resolveStop, entryCandidates, overviewView, stopShowsLabels, eveningLightPoints, topDown,
    walkKey, walkFov, flightMs, travel, ease, smoother, easeFrom, heading, planPath, planFlight, viewAt, tweenView, createFlight, makeGate, dwellMs,
    solidsFor, solidsOf, solidIndex, camOK, visibility, insideSolid, segClear, projectPts, routeCrossings, itemPts,
    EYE, EYE_MIN, EYE_FOV, WALK_FOV, OVERVIEW_FOV, CLEAR, FILL, PITCH_MIN, PITCH_MAX, NAV_GAP_MS, DWELL_MS, DEFAULT_BAND, ACCESSORY, ENVELOPE, MARKER };
  G.HelmWalkthrough = API;
  /* ------------------------------ UI ------------------------------ */
  const doc = G.document;
  if (!doc || !doc.querySelector || doc.querySelector('meta[name="helm-capture"]')) return;

  function el(tag, cls, text) { const e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function reduced() { try { return !!(G.matchMedia && G.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (_) { return false; } }
  const H3 = () => G.__helm3D;
  const hallNow = () => (typeof WORLD !== 'undefined' ? WORLD : { w: 200, h: 140 });       // eslint-disable-line no-undef
  const itemsNow = () => (typeof store !== 'undefined' && store.items ? store.items : []);  // eslint-disable-line no-undef
  const nowMs = () => G.performance.now();

  async function ensure3D() {
    if (H3() && H3().isActive()) return true;
    const b = doc.querySelector('#viewSeg [data-v="3d"]'); if (!b) return false;
    b.click();
    for (let i = 0; i < 100; i++) { await new Promise((r) => setTimeout(r, 100)); if (H3() && H3().isActive()) return true; }
    return false;
  }

  // ---- the single in-flight camera move ----
  let flight = null;
  function stopFlight() { if (flight) { flight.cancel(); flight = null; } const h = H3(); if (h && h.setFlying) h.setFlying(false); }
  /* Fly from the LIVE view (the user may have orbited) to `to` along a path that clears every solid. Next /
     Prev mid-flight hands the current speed to the new flight. Reduced motion = an instant cut that still
     calls done() (so auto-play keeps its dwell). */
  function fly(to, done) {
    const h = H3(); if (!h) return;
    let v0 = 0;
    const from = h.getView();
    const ignore = new Set();
    if (W) { for (const s of W.stops) if (s.key === 'entrance') (s.owns || []).forEach((k) => ignore.add(k)); }
    const plan = planFlight(from, to, { index: W && W.stops.index, hall: W && W.stops.hall, ignore, reduced: reduced() });
    if (flight && flight.active && plan.ms > 0) {
      const v = flight.velocity(), t0 = sub(plan.path.at(0.02), plan.path.at(0)), tl = len(t0) || 1, sp = plan.L / plan.ms;
      if (sp > 1e-6) v0 = clamp((v[0] * t0[0] + v[1] * t0[1] + v[2] * t0[2]) / tl / sp, 0, 2);
      if (v0 > 1e-3) plan.ease = easeFrom(v0);
    }
    if (flight) { flight.cancel(); flight = null; }
    if (h.setFlying) h.setFlying(true);   // controls paused, damping flushed, orbit limits relaxed for the glide
    if (h.setHighlight) h.setHighlight(null);
    let f = null;
    f = createFlight({ from, to, plan, now: nowMs, raf: (fn) => G.requestAnimationFrame(fn), caf: (id) => G.cancelAnimationFrame(id),
      apply: (v) => h.setView(v.pos, v.target, null, v.fov),
      done: () => { if (!f || flight === f) flight = null; if (h.setFlying) h.setFlying(false); if (done) done(); } });
    flight = f.active ? f : null;   // M6: an instant (reduced-motion) cut leaves no dead stub behind
  }

  // ---- walkaround state ----
  let W = null;   // { stops, i, saved, from2D, auto, exploring, dwell, labels, entry, returnFocus }
  const ov = el('div', 'wt-overlay'); ov.hidden = true; ov.setAttribute('role', 'region'); ov.setAttribute('aria-label', 'Venue walkaround');
  const card = el('div', 'wt-card');
  const head = el('div', 'wt-head'), kicker = el('div', 'wt-kicker'), status = el('div', 'wt-status');
  head.append(kicker, status);
  const title = el('div', 'wt-title'), desc = el('div', 'wt-desc'), prog = el('div', 'wt-prog'), progBar = el('span', 'wt-prog-bar');
  prog.append(progBar); prog.setAttribute('aria-hidden', 'true');
  const dots = el('div', 'wt-dots'); dots.setAttribute('role', 'group'); dots.setAttribute('aria-label', 'Stops');
  const nav = el('div', 'wt-nav');
  const bPrev = el('button', 'wt-btn', '‹ '); bPrev.append(el('span', 'wt-tx', 'Previous')); bPrev.setAttribute('aria-label', 'Previous stop');
  const bPlay = el('button', 'wt-btn wt-play', '❚❚ Pause'), bNext = el('button', 'wt-btn wt-primary', 'Next ›');
  const bMore = el('button', 'wt-btn wt-more', '⋯'), bWLab = el('button', 'wt-btn wt-opt', 'Labels'), bList = el('button', 'wt-btn wt-opt', '☰ Zones'), bExit = el('button', 'wt-btn wt-exit', '✕ Exit');
  [bPrev, bPlay, bNext, bMore, bWLab, bList, bExit].forEach((b) => { b.type = 'button'; });
  bPrev.title = 'Previous stop (←)'; bNext.title = 'Next stop (→)'; bPlay.title = 'Play / pause the tour (Space or K)'; bExit.title = 'Leave the walkaround (Esc)';
  bMore.setAttribute('aria-label', 'More options'); bMore.setAttribute('aria-expanded', 'false');
  bPlay.setAttribute('aria-pressed', 'true');
  bWLab.title = 'Show or hide name tags during the walkaround';
  nav.append(bPrev, bPlay, bNext, bMore, bWLab, bList, bExit);
  const list = el('ol', 'wt-list'); list.hidden = true; list.id = 'wtZones'; list.setAttribute('aria-label', 'Every stop of the walkaround');
  bList.setAttribute('aria-controls', 'wtZones'); bList.setAttribute('aria-expanded', 'false');
  const live = el('div', 'wt-live'); live.setAttribute('aria-live', 'polite'); live.setAttribute('role', 'status');
  // "Start from": every entry point found in the layout; the choice is remembered per quote
  const fromWrap = el('label', 'wt-from wt-opt'); const fromSel = el('select', 'wt-from-sel');
  fromSel.setAttribute('aria-label', 'Start the walkaround from');
  fromWrap.append(el('span', 'wt-from-lbl', 'Start from'), fromSel);
  card.append(head, title, desc, prog, fromWrap, dots, nav);
  const entryKey = () => { let q = ''; try { q = new URLSearchParams(G.location.search).get('quote') || ''; } catch (_) {} return 'helm.wt.entry.' + (q.replace(/[^A-Za-z0-9-]/g, '').slice(0, 64) || 'draft'); };
  const loadEntry = () => { try { return G.localStorage.getItem(entryKey()) || ''; } catch (_) { return ''; } };
  const saveEntry = (v) => { try { G.localStorage.setItem(entryKey(), v); } catch (_) {} };
  fromSel.addEventListener('change', () => {
    if (!W) return; saveEntry(fromSel.value); W.entry = fromSel.value;
    rebuild('entrance');
  });
  ov.append(list, card, live);

  // what the stop card / tool bar / zone list cover of the canvas: the stops are framed in the rest
  function measure() {
    const out = { aspect: 16 / 9, band: DEFAULT_BAND };
    try {
      const st = doc.getElementById('stage3d') || doc.getElementById('scene3d'); if (!st) return out;
      const sr = st.getBoundingClientRect(); if (!(sr.width > 50 && sr.height > 50)) return out;
      out.aspect = sr.width / sr.height;
      const cr = card.getBoundingClientRect(), tb = doc.getElementById('tools3d');
      const t = tb && !tb.hidden && tb.getBoundingClientRect().height > 0 ? Math.max(0, tb.getBoundingClientRect().bottom - sr.top + 6) / sr.height : 0.04;
      const b = cr.height > 0 ? Math.max(0, sr.bottom - cr.top + 8) / sr.height : DEFAULT_BAND.b;
      const lr = !list.hidden ? list.getBoundingClientRect() : null, l = lr && lr.width > 0 ? Math.max(0, lr.right - sr.left + 8) / sr.width : 0;
      out.band = { t: clamp(t, 0, 0.3), b: clamp(b + 0.04, 0, 0.45), l: clamp(l, 0, 0.4), r: 0.01 };   // + room for a two-line caption
    } catch (_) {}
    return out;
  }
  function plan(entry) {
    const m = measure(), h = H3(); let hits = 0;
    const S = walkthroughStops(itemsNow(), hallNow(), { aspect: m.aspect, band: m.band, entry, bounds: h && h.boundsOf ? (id) => { const b = h.boundsOf(id); if (b) hits++; return b; } : null });
    S.realBounds = hits > 0;
    return S;
  }
  // re-plan (layout changed, resized, rotated, fullscreen, new entry): keep the stop the user is on
  function rebuild(reason) {
    if (!W) return;
    const cur = W.stops[W.i] && W.stops[W.i].key, keepAuto = W.auto && !W.exploring;
    W.stops = plan(W.entry); W.aspectAt = measure().aspect; W.sig = layoutSig();
    const k = reason === 'entrance' ? W.stops.findIndex((s) => s.key === 'entrance') : W.stops.findIndex((s) => s.key === cur);
    W.i = k >= 0 ? k : Math.min(W.i, W.stops.length - 1);
    useGuard(); paintList(); show({ quiet: reason === 'resize' || reason === 'bounds' });
    if (keepAuto && !W.auto) setAuto(true);
  }
  function useGuard() {
    const h = H3(); if (!h || !h.setWalkGuard || !W) return;
    const idx = W.stops.index;
    h.setWalkGuard((p) => p[1] >= 1 && !(idx && insideSolid(p, idx, 0.5)));
  }

  function show(o) {
    const s = W.stops[W.i], n = W.stops.length;
    kicker.textContent = `Stop ${W.i + 1} of ${n}`;
    title.textContent = s.title; desc.textContent = s.desc;
    bPrev.disabled = W.i === 0; bNext.textContent = W.i === n - 1 ? 'Finish ✓' : 'Next ›';
    dots.replaceChildren(...W.stops.map((x, k) => { const d = el('button', 'wt-dot' + (k === W.i ? ' on' : '')); d.type = 'button';
      d.setAttribute('aria-label', `Stop ${k + 1} of ${n}: ${x.title}`); if (k === W.i) d.setAttribute('aria-current', 'step');
      d.addEventListener('click', () => { setAuto(false); go(k); }); return d; }));
    list.querySelectorAll('button').forEach((b, k) => { b.classList.toggle('on', k === W.i); if (k === W.i) b.setAttribute('aria-current', 'step'); else b.removeAttribute('aria-current'); });
    W.exploring = false; syncStatus();
    syncLabels(); dwellStop();
    const h = H3(); if (h && h.setRoofsHidden) h.setRoofsHidden(!!s.hideRoofs);
    if (!(o && o.quiet)) live.textContent = `Stop ${W.i + 1} of ${n}: ${s.title} — ${s.desc}`;
    fly(s, arrived);
  }
  function arrived() {
    if (!W) return; const s = W.stops[W.i], h = H3();
    const dd = len(sub(s.target, s.pos));   // limits always contain the stop's own distance, so landing never gets clamped
    if (h && h.setStopLimits) h.setStopLimits(s.view === 'overview' ? { minD: Math.min(10, 0.5 * dd), maxD: Math.max(1.6 * dd, 400) } : { minD: Math.min(s.minD || 4, 0.9 * dd), maxD: Math.max(s.maxD || 120, 1.2 * dd) });
    if (h && h.setHighlight) h.setHighlight(s.view === 'overview' ? null : (s.subject || []));
    if (W.auto && !W.exploring) dwellStart();
  }
  // ---- auto-play dwell: pausable (hidden tab, exploring), caption-length aware, with a progress bar ----
  function dwellStop() { if (W && W.dwell) { clearTimeout(W.dwell.timer); if (W.dwell.anim) try { W.dwell.anim.cancel(); } catch (_) {} W.dwell = null; } progBar.style.transform = 'scaleX(0)'; }
  function dwellStart() {
    dwellStop(); if (!W) return;
    const ms = dwellMs(W.stops[W.i]), d = { left: ms, at: nowMs(), timer: null, anim: null };
    d.timer = setTimeout(dwellDone, ms);
    if (progBar.animate && !reduced()) { try { d.anim = progBar.animate([{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], { duration: ms, fill: 'forwards', easing: 'linear' }); } catch (_) { d.anim = null; } }
    W.dwell = d;
  }
  function dwellPause() { const d = W && W.dwell; if (!d || d.timer == null) return; clearTimeout(d.timer); d.timer = null; d.left = Math.max(0, d.left - (nowMs() - d.at)); if (d.anim) try { d.anim.pause(); } catch (_) {} }
  function dwellResume() { const d = W && W.dwell; if (!d || d.timer != null) return; d.at = nowMs(); d.timer = setTimeout(dwellDone, d.left); if (d.anim) try { d.anim.play(); } catch (_) {} }
  function dwellDone() { if (!W || !W.auto) return; W.dwell = null; if (W.i >= W.stops.length - 1) setAuto(false); else go(W.i + 1); }

  function paintList() {
    list.replaceChildren(...W.stops.map((s, k) => {
      const li = el('li'); const b = el('button', 'wt-zone'); b.type = 'button';
      const txt = el('span', 'wt-zt'); txt.append(el('span', 'wt-zname', s.title), el('span', 'wt-zdesc', s.desc));
      b.append(el('span', 'wt-zn', String(k + 1).padStart(2, '0')), txt);
      b.addEventListener('click', () => { setAuto(false); go(k); }); li.append(b); return li;
    }));
  }
  function syncLabels() {
    if (!W) return; const s = W.stops[W.i], on = stopShowsLabels(s, W.labels);
    bWLab.setAttribute('aria-pressed', String(on)); bWLab.textContent = on ? 'Labels on' : 'Labels off';
    const h = H3(); if (!h) return;
    if (h.setLabelFocus) h.setLabelFocus(!on && W.labels !== false && s.view !== 'overview' ? (s.subject || []) : null);
    if (h.setLabelsHidden) h.setLabelsHidden(!on);
  }
  function syncStatus() {
    if (!W) return;
    status.textContent = W.exploring ? 'Paused — exploring' : '';
    bPlay.textContent = W.exploring ? '▶ Resume' : W.auto ? '❚❚ Pause' : '▶ Play';
    bPlay.setAttribute('aria-pressed', String(!!W.auto && !W.exploring));
    card.classList.toggle('exploring', !!W.exploring);
  }
  function go(i) { if (!W) return; const j = clamp(i, 0, W.stops.length - 1); if (j === W.i && flight) return; W.i = j; show(); }
  const keyGate = makeGate(NAV_GAP_MS, nowMs);
  function next() { if (!W) return; if (W.i >= W.stops.length - 1) { if (W.auto) setAuto(false); else exit(); return; } go(W.i + 1); }
  function setAuto(on) {
    if (!W) return; W.auto = !!on;
    if (on && W.exploring) { W.exploring = false; syncStatus(); show(); return; }   // Resume: fly back to the stop, then carry on
    syncStatus();
    if (!on) dwellStop(); else if (!flight) dwellStart();
  }
  // the user takes over (drag / wheel / pinch on the 3D view): the camera stays where it is, auto-play pauses
  function explore() {
    if (!W) return;
    if (flight) { flight.cancel(); flight = null; const h = H3(); if (h && h.setFlying) h.setFlying(false); arrivedLimitsOnly(); }
    dwellStop(); W.auto = false; W.exploring = true; syncStatus();
  }
  function arrivedLimitsOnly() { const h = H3(); if (h && h.setStopLimits) h.setStopLimits({ minD: 4, maxD: Math.max(400, (W.stops[0] && W.stops[0].d) || 400) }); }

  async function start() {
    if (W) return;
    const returnFocus = doc.activeElement;
    const from2D = !(H3() && H3().isActive());
    if (!(await ensure3D())) return;
    if (W) return;
    const h = H3(), saved = h.getView();
    // nothing can be edited during the tour: selection cleared, gizmo + click-select off (builder-3d walk mode)
    try { if (typeof G.clearSelection === 'function') { G.clearSelection(); if (typeof G.renderAll === 'function') G.renderAll(); } } catch (_) {}
    const cands = entryCandidates(itemsNow(), hallNow());
    const remembered = loadEntry(); const entry = cands.some((c) => c.id === remembered) ? remembered : cands[0].id;
    fromSel.replaceChildren(...cands.map((c) => { const o = el('option', null, c.label); o.value = c.id; return o; }));
    fromSel.value = entry;
    ov.hidden = false; doc.body.classList.add('wt-on');      // the card is laid out before we measure what it covers
    title.textContent = 'Venue overview'; desc.textContent = ' ';
    W = { stops: [], i: 0, saved, from2D, auto: true, exploring: false, dwell: null, labels: null, entry, returnFocus };
    W.stops = plan(entry); W.aspectAt = measure().aspect; W.sig = layoutSig();
    if (h.setWalkMode) h.setWalkMode(true);
    useGuard(); paintList(); show(); syncStatus();
    if (!W.stops.realBounds && itemsNow().length) setTimeout(() => { if (W && !W.stops.realBounds) rebuild('bounds'); }, 600);   // the 3D meshes were not built yet
    try { bPlay.focus({ preventScroll: true }); } catch (_) { bPlay.focus(); }
  }
  function exit() {
    if (!W) return; const w = W; W = null;
    if (w.dwell) clearTimeout(w.dwell.timer);
    stopFlight();
    const h = H3();
    if (h) { if (h.setWalkGuard) h.setWalkGuard(null); if (h.setHighlight) h.setHighlight(null); if (h.setLabelFocus) h.setLabelFocus(null); if (h.setRoofsHidden) h.setRoofsHidden(false);
      if (h.setWalkMode) h.setWalkMode(false); if (h.setLabelsHidden) h.setLabelsHidden(false); }   // back to the user's own label mode
    ov.hidden = true; list.hidden = true; bList.setAttribute('aria-expanded', 'false'); card.classList.remove('more'); doc.body.classList.remove('wt-on');
    if (h && w.saved) h.setView(w.saved.pos, w.saved.target, w.saved.minD, w.saved.fov);
    if (w.from2D) { const b = doc.querySelector('#viewSeg [data-v="2d"]'); if (b) b.click(); }
    const f = w.returnFocus && w.returnFocus.isConnected && w.returnFocus.offsetParent !== null ? w.returnFocus : (doc.getElementById('wtStart') && doc.getElementById('wtStart').offsetParent ? doc.getElementById('wtStart') : null);
    if (f && f.focus) try { f.focus({ preventScroll: true }); } catch (_) {}
  }
  function toggleList(open) {
    const on = open == null ? list.hidden : !!open; list.hidden = !on; bList.setAttribute('aria-expanded', String(on));
    if (on) { const cur = list.querySelector('button.on') || list.querySelector('button'); if (cur) cur.focus(); }
  }
  bPrev.addEventListener('click', () => go(W ? W.i - 1 : 0));
  bNext.addEventListener('click', () => next());
  bPlay.addEventListener('click', () => setAuto(!(W && W.auto && !W.exploring)));
  bWLab.addEventListener('click', () => { if (!W) return; W.labels = !stopShowsLabels(W.stops[W.i], W.labels); syncLabels(); });
  bList.addEventListener('click', () => toggleList());
  bMore.addEventListener('click', () => { const on = !card.classList.contains('more'); card.classList.toggle('more', on); bMore.setAttribute('aria-expanded', String(on)); });
  bExit.addEventListener('click', exit);
  // mobile: a horizontal swipe on the card = next / previous
  { let sx = null, sy = 0;
    card.addEventListener('pointerdown', (e) => { if (e.target.closest && e.target.closest('button, select')) { sx = null; return; } sx = e.clientX; sy = e.clientY; });
    card.addEventListener('pointerup', (e) => { if (sx == null || !W) return; const dx = e.clientX - sx, dy = e.clientY - sy; sx = null;
      if (Math.abs(dx) > 50 && Math.abs(dx) > 1.5 * Math.abs(dy)) { setAuto(false); if (dx < 0) next(); else go(W.i - 1); } }); }
  // using anything else in the builder (toolbar, panels, toolbox, 2D/3D switch...) ends the walkthrough first,
  // so every feature works normally - no need to press Exit. A drag / click on the 3D view = "exploring".
  doc.addEventListener('pointerdown', (e) => {
    if (!W) return; const t = e.target;
    if (!t || !t.closest || ov.contains(t) || t.closest('.wt-overlay, .wt-list, #fabStack, .modal, .bpui-overlay')) return;
    if (t.closest('canvas, #scene3d')) { explore(); return; }
    const to2D = !!t.closest('#viewSeg [data-v="2d"]');
    if (to2D) W.from2D = false;   // the click itself switches to 2D - don't switch twice
    exit();
  }, true);
  const onCanvasInput = (e) => { if (!W) return; const t = e.target; if (t && t.closest && t.closest('canvas, #scene3d')) explore(); };
  doc.addEventListener('wheel', onCanvasInput, { capture: true, passive: true });
  doc.addEventListener('touchstart', onCanvasInput, { capture: true, passive: true });
  G.addEventListener('keydown', (e) => {
    if (!W) return;
    const tag = e.target && e.target.tagName || '';
    const a = walkKey(e.key, e);
    if (/INPUT|SELECT|TEXTAREA/.test(tag) && a !== 'exit') return;
    if (!a) return;
    if (a === 'toggle' && e.key === ' ' && tag === 'BUTTON') return;   // Space on a focused button presses it
    e.preventDefault(); e.stopImmediatePropagation();
    if (a === 'block') return;                                          // no layout edits during the tour
    if (a === 'exit') { if (!list.hidden) { toggleList(false); bList.focus(); } else if (card.classList.contains('more')) { card.classList.remove('more'); bMore.setAttribute('aria-expanded', 'false'); } else exit(); return; }
    if (a === 'toggle') { setAuto(!(W.auto && !W.exploring)); return; }
    if (e.repeat && !keyGate.allow()) return;
    if (a === 'next') next(); else if (a === 'prev') go(W.i - 1); else if (a === 'first') go(0); else if (a === 'last') go(W.stops.length - 1);
  }, true);
  // a hidden tab pauses the flight and the dwell (no jump, no stop skipped in the background)
  doc.addEventListener('visibilitychange', () => { if (!W) return; if (doc.hidden) { if (flight) flight.pause(); dwellPause(); } else { if (flight) flight.resume(); dwellResume(); } });
  // the framing depends on the canvas aspect: re-solve on resize / rotate / fullscreen
  let rsT = null;
  G.addEventListener('resize', () => { if (!W) return; clearTimeout(rsT); rsT = setTimeout(() => { if (W && Math.abs(measure().aspect - (W.aspectAt || 0)) > 0.02) rebuild('resize'); }, 220); });
  // a layout change (sync, undo from elsewhere) re-plans the stops
  let lcT = null;
  const layoutSig = () => { const h = hallNow(); return h.w + 'x' + h.h + '|' + itemsNow().map((i) => i && [i.id, i.type, i.x, i.y, i.width, i.height, i.rotation, i.hidden ? 1 : 0].join(',')).join(';'); };
  // renderAll() pings this for every repaint: only a real change of the items / hall re-plans the tour
  function layoutChanged() { if (!W) return; clearTimeout(lcT); lcT = setTimeout(() => { if (W && layoutSig() !== W.sig) rebuild('layout'); }, 350); }
  // photo render of the current stop: the same subject re-framed for the render's own aspect (no UI band)
  function viewFor(aspect) {
    if (!W || W.exploring || flight) return null;
    const s = W.stops[W.i]; return resolveStop(s, { aspect, band: { t: 0, b: 0, l: 0, r: 0 } });
  }

  // ---- presets ----
  async function preset(kind) {
    if (W) exit();
    if (!(await ensure3D())) return;
    const h = H3(), hall = hallNow();
    const v0 = h.getView();
    if (kind === 'overview') fly(overviewView(hall, v0 && v0.aspect, OVERVIEW_FOV, 0.8));
    else if (kind === 'top') fly(Object.assign({ fov: OVERVIEW_FOV }, topDown(hall, topDownView(v0))));
    else if (kind === 'evening') { const on = h.setEvening(!h.isEvening()); bEve.setAttribute('aria-pressed', String(on)); bEve.classList.toggle('on', on); }
  }
  // r20: how much of the 3D canvas the floating Move / Rotate / Scale bar (top) and the hint bar (bottom) cover
  function topDownView(v0) {
    try {
      const st = doc.getElementById('stage3d'); if (!st) return null;
      const sr = st.getBoundingClientRect(); if (!(sr.width > 50 && sr.height > 50)) return null;
      const cover = (id, edge) => { const e = doc.getElementById(id); if (!e || e.hidden) return 0; const r = e.getBoundingClientRect(); if (!(r.height > 0)) return 0;
        return edge === 'top' ? Math.max(0, r.bottom - sr.top + 8) / sr.height : Math.max(0, sr.bottom - r.top + 8) / sr.height; };
      return { aspect: (v0 && v0.aspect) || sr.width / sr.height, fovDeg: OVERVIEW_FOV, top: cover('tools3d', 'top'), bottom: cover('hint3d', 'bottom'), side: 0.02 };
    } catch (_) { return null; }
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
  const mk = (t, ttl, fn) => { const b = el('button', null, t); b.type = 'button'; b.title = ttl; b.addEventListener('click', fn); seg.append(b); return b; };
  const bWalk = mk('⌾ Walkthrough', 'Guided 3D walkaround past every item in the venue (Space pauses, ← → step, Esc exits)', start);
  bWalk.id = 'wtStart';
  mk('↗ Overview', 'Three-quarter overview of the whole venue (3D)', () => preset('overview'));
  mk('▧ Floor plan', 'Top-down floor plan in 3D', () => preset('top'));
  const bEve = mk('☾ Evening', 'Evening lighting: darker room, warm lights on the stage and tables', () => preset('evening'));
  bEve.setAttribute('aria-pressed', 'false');
  const bLab = mk('Labels off', 'Show or hide labels in 3D', toggleLabels);
  field.append(lbl, seg);
  const fab = el('button', 'wt-fab', '⌾ Walkthrough'); fab.type = 'button'; fab.hidden = true; fab.title = 'Start the guided venue walkaround';
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
  API._ui = { start, exit, preset, state: () => W, layoutChanged, viewFor, explore, setAuto, go, rebuild };
})(typeof window !== 'undefined' ? window : globalThis);
