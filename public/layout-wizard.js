/* layout-wizard.js — the "Create layout" requirements wizard (replaces the round-tables-only Custom Event
 * generator as the primary entry point; the classic template dialog stays one click away).
 *
 *   HelmWizard.TYPES / OBJECTS        event types → suggested objects (preselected, mandatory, qty, size)
 *   HelmWizard.defaults(type, o)      a complete spec pre-filled for a type, guests, chairs, hall
 *   HelmWizard.seatPlan(spec)         live seat maths: main seating + every extra seat (VIP sofas/rows, dais)
 *   HelmWizard.layout(spec, deps)     deterministic placement: exactly the planned seats, requested objects,
 *                                     nothing overlapping, everything inside the hall, honest warnings
 *   UI (browser only)                 a 4-step accessible dialog, prefilled from the quote, remembered per quote
 *
 * All sizes inside a spec are FEET. The dialog converts metres on input/output only.
 * No inline styles or handlers (CSP hash-only): every element is created here and styled by layout-wizard.css. */
(function (G) {
  'use strict';
  const M2FT = 3.28084;
  const r1 = (v) => Math.round(v * 10) / 10;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const posInt = (v) => { const n = Math.round(+v); return isFinite(n) && n > 0 ? n : 0; };

  /* ---------------- catalogue ----------------
   * size: 'wh' (L×W editable) | 'w' (width only) | null.  seats: seats per unit (counted in the total).
   * zone drives where the placer puts it first; anything blocked falls back to the nearest free spot. */
  const OBJECTS = {
    stage:      { type: 'stage',       label: 'Stage',                  size: 'wh', zone: 'stage' },
    mandap:     { type: 'mandap',      label: 'Mandap',                 size: 'wh', zone: 'stageSide' },
    backdrop:   { type: 'floralarch',  label: 'Floral arch backdrop',   size: 'w',  zone: 'backdrop' },
    brandwall:  { type: 'brandwall',   label: 'Branding wall',          size: 'w',  zone: 'backdrop' },
    lighting:   { type: 'lighting',    label: 'Lighting truss',         size: 'w',  zone: 'truss' },
    podium:     { type: 'podium',      label: 'Podium',                 size: null, zone: 'onStage' },
    dais:       { type: 'chairrow',    label: 'Dais chairs on stage',   size: null, zone: 'onStage', seatsField: true, seats: 8 },
    dj:         { type: 'dj',          label: 'DJ console',             size: null, zone: 'stageRight' },
    dancefloor: { type: 'dancefloor',  label: 'Dance floor',            size: 'wh', zone: 'front' },
    standing:   { type: 'dancefloor',  label: 'Standing zone',          size: 'wh', zone: 'front' },
    walkway:    { type: 'walkway',     label: 'Walkway / ramp',         size: 'wh', zone: 'walkway' },
    barricade:  { type: 'barricade',   label: 'Barricade',              size: null, zone: 'pit' },
    led:        { type: 'led',         label: 'LED screens',            size: 'w',  zone: 'flank', multi: true },
    linearray:  { type: 'linearray',   label: 'Line array speakers',    size: null, zone: 'flank', multi: true },
    floral:     { type: 'floral',      label: 'Flower decor',           size: null, zone: 'stageFront', multi: true },
    vipsofa:    { type: 'sofa',        label: 'VIP sofas',              size: null, zone: 'vip', multi: true, seats: 3 },
    viprow:     { type: 'chairrow',    label: 'VIP chair rows',         size: null, zone: 'vip', multi: true, seatsField: true, seats: 12 },
    press:      { type: 'press',       label: 'Press area',             size: null, zone: 'sideRight' },
    buffet:     { type: 'buffet',      label: 'Buffet tables',          size: null, zone: 'wallRight', multi: true },
    caketable:  { type: 'caketable',   label: 'Cake table',             size: null, zone: 'nearDance' },
    bar:        { type: 'bar',         label: 'Bar',                    size: null, zone: 'wallLeft', multi: true },
    photobooth: { type: 'photobooth',  label: 'Photo booth',            size: null, zone: 'wallLeft' },
    gifttable:  { type: 'gifttable',   label: 'Gift table',             size: null, zone: 'nearEntrance' },
    cocktail:   { type: 'cocktail',    label: 'Cocktail tables (standing)', size: null, zone: 'back', multi: true, seats: 0 },
    desk:       { type: 'desk',        label: 'Registration desk',      size: null, zone: 'nearEntrance', multi: true },
    foh:        { type: 'foh',         label: 'FOH console',            size: null, zone: 'foh' },
    generator:  { type: 'generator',   label: 'Generator',              size: null, zone: 'backCorner' },
    restroom:   { type: 'restroom',    label: 'Restrooms',              size: null, zone: 'back', multi: true },
    firstaid:   { type: 'firstaid',    label: 'First aid',              size: null, zone: 'back' },
    entrance:   { type: 'arch',        label: 'Entrance',               size: null, zone: 'entrance' },
    exit:       { type: 'exit',        label: 'Exits',                  size: null, zone: 'exits', multi: true },
  };
  // [key, on by default, qty, mandatory]
  const WEDDING = [['stage', 1, 1, 1], ['mandap', 1, 1], ['backdrop', 1, 1], ['dj', 1, 1], ['dancefloor', 1, 1], ['led', 1, 2],
    ['buffet', 1, 2], ['caketable', 1, 1], ['entrance', 1, 1, 1], ['floral', 1, 4], ['photobooth', 1, 1], ['bar', 0, 1],
    ['gifttable', 1, 1], ['vipsofa', 1, 4], ['linearray', 0, 2], ['exit', 1, 2, 1]];
  const TYPES = {
    wedding:        { label: 'Wedding',               seating: 'rounds',  objects: WEDDING },
    reception:      { label: 'Reception',             seating: 'rounds',  objects: WEDDING.map((o) => o[0] === 'mandap' ? ['mandap', 0, 1] : o[0] === 'bar' ? ['bar', 1, 1] : o[0] === 'buffet' ? ['buffet', 1, 2, 1] : o) },
    engagement:     { label: 'Engagement / sangeet',  seating: 'rounds',  objects: WEDDING.map((o) => o[0] === 'mandap' ? ['mandap', 0, 1] : o[0] === 'led' ? ['led', 0, 2] : o) },
    birthday:       { label: 'Birthday / private party', seating: 'rounds', objects: [['stage', 1, 1], ['caketable', 1, 1, 1], ['dj', 1, 1], ['dancefloor', 1, 1],
      ['backdrop', 1, 1], ['buffet', 1, 1], ['photobooth', 1, 1], ['gifttable', 1, 1], ['floral', 0, 2], ['bar', 0, 1], ['led', 0, 1], ['vipsofa', 0, 2], ['entrance', 1, 1, 1], ['exit', 1, 2, 1]] },
    political:      { label: 'Political rally / public meeting', seating: 'theatre', objects: [['stage', 1, 1, 1], ['podium', 1, 1, 1], ['dais', 1, 1], ['brandwall', 1, 1],
      ['led', 1, 2], ['linearray', 1, 2, 1], ['barricade', 1, 1, 1], ['walkway', 1, 1], ['generator', 1, 1, 1], ['press', 1, 1], ['viprow', 1, 2],
      ['lighting', 1, 1], ['entrance', 1, 1, 1], ['firstaid', 0, 1], ['restroom', 0, 2], ['exit', 1, 2, 1]] },
    corporate:      { label: 'Corporate event',       seating: 'theatre', objects: [['stage', 1, 1, 1], ['podium', 1, 1], ['led', 1, 2], ['brandwall', 1, 1],
      ['desk', 1, 1, 1], ['cocktail', 1, 6], ['linearray', 1, 2], ['lighting', 0, 1], ['buffet', 0, 1], ['bar', 0, 1], ['photobooth', 0, 1], ['vipsofa', 0, 2], ['entrance', 1, 1, 1], ['exit', 1, 2, 1]] },
    product_launch: { label: 'Product launch',        seating: 'theatre', objects: [['stage', 1, 1, 1], ['podium', 1, 1], ['led', 1, 2, 1], ['brandwall', 1, 1, 1],
      ['desk', 1, 1, 1], ['cocktail', 1, 8], ['linearray', 1, 2], ['lighting', 1, 1], ['photobooth', 1, 1], ['bar', 0, 1], ['vipsofa', 0, 2], ['entrance', 1, 1, 1], ['exit', 1, 2, 1]] },
    conference:     { label: 'Conference / seminar',  seating: 'theatre', objects: [['stage', 1, 1, 1], ['podium', 1, 1, 1], ['led', 1, 2], ['desk', 1, 2, 1],
      ['brandwall', 0, 1], ['linearray', 1, 2], ['buffet', 0, 1], ['cocktail', 0, 4], ['entrance', 1, 1, 1], ['exit', 1, 2, 1]] },
    concert:        { label: 'Concert / live music',  seating: 'standing', objects: [['stage', 1, 1, 1], ['linearray', 1, 2, 1], ['barricade', 1, 1, 1], ['foh', 1, 1, 1],
      ['standing', 1, 1, 1], ['led', 1, 2], ['lighting', 1, 1], ['walkway', 0, 1], ['generator', 1, 1], ['bar', 1, 2], ['restroom', 1, 2], ['firstaid', 1, 1], ['vipsofa', 0, 4], ['entrance', 1, 1, 1], ['exit', 1, 2, 1]] },
    festival:       { label: 'Festival / outdoor',    seating: 'standing', objects: [['stage', 1, 1, 1], ['linearray', 1, 2, 1], ['barricade', 1, 1, 1], ['foh', 1, 1, 1],
      ['standing', 1, 1, 1], ['led', 1, 2], ['lighting', 1, 1], ['generator', 1, 1, 1], ['bar', 1, 2], ['restroom', 1, 4], ['firstaid', 1, 1, 1], ['entrance', 1, 1, 1], ['exit', 1, 2, 1]] },
    // UAE audit (0102): Gulf event types - halal buffet + majlis seating, no dance-floor / bar defaults
    galadinner:     { label: 'Gala dinner',           seating: 'rounds',  objects: WEDDING.map((o) => o[0] === 'mandap' || o[0] === 'caketable' ? [o[0], 0, o[2]] : o) },
    iftar:          { label: 'Iftar / Ramadan tent',  seating: 'rounds',  objects: [['buffet', 1, 4, 1], ['vipsofa', 1, 6], ['backdrop', 1, 1], ['floral', 0, 2], ['lighting', 1, 1],
      ['desk', 0, 1], ['stage', 0, 1], ['restroom', 0, 2], ['entrance', 1, 1, 1], ['exit', 1, 2, 1]] },
    eid:            { label: 'Eid / National Day celebration', seating: 'rounds', objects: [['stage', 1, 1, 1], ['backdrop', 1, 1], ['dancefloor', 1, 1], ['led', 1, 2], ['linearray', 1, 2], ['buffet', 1, 2],
      ['lighting', 1, 1], ['photobooth', 1, 1], ['vipsofa', 1, 4], ['floral', 0, 2], ['firstaid', 0, 1], ['entrance', 1, 1, 1], ['exit', 1, 2, 1]] },
    exhibition:     { label: 'Exhibition / trade show', seating: 'standing', objects: [['desk', 1, 2, 1], ['brandwall', 1, 1], ['standing', 1, 1, 1], ['led', 1, 2], ['cocktail', 1, 8],
      ['lighting', 1, 1], ['stage', 0, 1], ['podium', 0, 1], ['buffet', 0, 1], ['restroom', 0, 2], ['firstaid', 0, 1], ['entrance', 1, 1, 1], ['exit', 1, 2, 1]] },
  };
  // UAE audit: which types a studio's country offers (India / others: every type, unchanged).
  // AE hides the political rally and the India-only wording; the wedding mandap starts OFF.
  const AE_HIDE = { political: 1 };
  const AE_LABEL = { engagement: 'Engagement / henna night', wedding: 'Wedding (kosha / stage)' };
  function typesFor(cc) {
    const ae = String(cc || '').toUpperCase() === 'AE', out = [];
    Object.keys(TYPES).forEach((k) => { if (ae && AE_HIDE[k]) return; out.push({ key: k, label: (ae && AE_LABEL[k]) || TYPES[k].label }); });
    return out;
  }
  function defaultUnit(cc) { return String(cc || '').toUpperCase() === 'IN' || !cc ? 'ft' : String(cc).toUpperCase() === 'US' ? 'ft' : 'm'; }
  const TYPE_ALIAS = { iftar: 'iftar', ramadan: 'iftar', suhoor: 'iftar', eid: 'eid', 'national day': 'eid', exhibition: 'exhibition', 'trade show': 'exhibition', gala: 'wedding', anniversary: 'wedding', sangeet: 'engagement', mehendi: 'engagement', mehndi: 'engagement', haldi: 'engagement', roka: 'engagement', cocktail: 'reception', rally: 'political', public_meeting: 'political',
    'public meeting': 'political', seminar: 'conference', expo: 'conference', 'product launch': 'product_launch', 'live music': 'concert' };
  function typeKey(t) {
    const k = String(t || '').toLowerCase().trim();
    if (TYPES[k]) return k; if (TYPE_ALIAS[k]) return TYPE_ALIAS[k];
    const u = k.replace(/[\s/]+/g, '_'); if (TYPES[u]) return u; if (TYPE_ALIAS[u]) return TYPE_ALIAS[u];
    // India audit 2: free-text types ("Political rally", "Birthday party", "Corporate offsite",
    // "Gala dinner") fell through to the wedding mandap — match any known word instead.
    const words = k.split(/[^a-z]+/).filter(Boolean);
    for (const w of words) { if (TYPES[w]) return w; if (TYPE_ALIAS[w]) return TYPE_ALIAS[w]; }
    return 'wedding';
  }
  const SEATING_STYLES = { rounds: 'Round tables', theatre: 'Theatre blocks', banquet: 'Banquet long tables', mixed: 'Mixed: rounds + theatre', standing: 'Standing (no main seating)' };

  // sensible default sizes (ft) for a hall
  function defaultSize(key, W, H, N) {
    const sc = (v, lo, hi) => Math.round(clamp(v, lo, hi) * 2) / 2;
    if (key === 'stage') return { w: sc(W * 0.3, 12, 60), h: sc(H * 0.14, 6, 20) };
    if (key === 'mandap') { const s = sc(Math.min(W, H) * 0.14, 8, 16); return { w: s, h: s }; }
    if (key === 'dancefloor') { const s = Math.round(clamp(Math.sqrt(Math.max(1, N || 80) * 2.5), 12, 24)); const m = Math.max(8, Math.min(s, Math.round(W * 0.3), Math.round(H * 0.25))); return { w: m, h: m }; }
    if (key === 'standing') return { w: sc(W * 0.45, 10, 80), h: sc(H * 0.16, 8, 40) };
    if (key === 'walkway') return { w: 4, h: sc(H * 0.12, 5, 30) };
    if (key === 'led') return { w: sc(W * 0.1, 6, 20) };
    if (key === 'backdrop') return { w: sc(W * 0.12, 6, 12) };
    if (key === 'brandwall' || key === 'lighting') return { w: sc(W * 0.3, 12, 60) };
    return {};
  }

  /* ---------------- spec ---------------- */
  function defaults(type, o) {
    o = o || {}; const tk = typeKey(type), T = TYPES[tk];
    const W = +o.w || 200, H = +o.h || 140, guests = posInt(o.guests);
    const chairs = posInt(o.chairs) || (guests ? Math.ceil(guests * 7 / 10) : 0);
    const objects = {};
    T.objects.forEach(([k, on, qty, mand]) => {
      const sz = defaultSize(k, W, H, chairs || guests);
      objects[k] = Object.assign({ on: !!(on || mand), qty: qty || 1, mandatory: !!mand }, sz,
        OBJECTS[k].seatsField ? { seats: OBJECTS[k].seats } : {});
    });
    if (String(o.country || '').toUpperCase() === 'AE' && objects.mandap && !objects.mandap.mandatory) objects.mandap.on = false;
    const spec = { type: tk, hall: { w: W, h: H }, unit: o.unit === 'm' ? 'm' : o.unit === 'ft' ? 'ft' : defaultUnit(o.country), guests, chairs, carpet: false, objects,
      seating: { style: T.seating, spt: 8, tables: 0, blocks: W >= 150 ? 4 : 2, rows: 0, cols: 14, aisle: 6, longTables: 0, perLong: 10, mixRounds: 0 } };
    // theatre rows sized to the hall: blocks side by side fill ~85% of its width
    spec.seating.cols = clamp(Math.floor((W * 0.85 - (spec.seating.blocks - 1) * 6) / spec.seating.blocks / 2.4), 4, 30);
    fitSeating(spec);
    return spec;
  }
  // extra seats: every seat counts (VIP sofas, VIP rows, dais chairs)
  function extraSeats(spec) {
    let n = 0;
    Object.entries(spec.objects || {}).forEach(([k, o]) => {
      const c = OBJECTS[k]; if (!c || !o || !o.on) return;
      const q = c.multi ? posInt(o.qty) : 1;
      if (c.seatsField) n += q * posInt(o.seats != null ? o.seats : c.seats);
      else if (c.seats) n += q * c.seats;
    });
    return n;
  }
  // main seating the style config holds (before trimming to a target)
  function mainCapacity(s) {
    const st = s.style;
    if (st === 'rounds') return posInt(s.tables) * posInt(s.spt);
    if (st === 'theatre') return posInt(s.blocks) * posInt(s.rows) * posInt(s.cols);
    if (st === 'banquet') return posInt(s.longTables) * posInt(s.perLong);
    if (st === 'mixed') return posInt(s.mixRounds) * posInt(s.spt) + posInt(s.blocks) * posInt(s.rows) * posInt(s.cols);
    return 0;
  }
  // live seat maths: target = chairs (70% of guests unless typed); main = target − extras, rounded to the config
  function seatPlan(spec) {
    const extras = extraSeats(spec), cap = mainCapacity(spec.seating), target = posInt(spec.chairs);
    const wantMain = target ? Math.max(0, target - extras) : cap;
    const main = spec.seating.style === 'standing' ? 0 : Math.min(cap, wantMain);
    const total = main + extras;
    return { extras, capacity: cap, main, total, target, short: target ? Math.max(0, target - total) : 0,
      match: !target || total === target, guests: posInt(spec.guests) };
  }
  // size the style's counts so main capacity covers (target − extras): tables = chairs ÷ 8 by default
  function fitSeating(spec) {
    const s = spec.seating, need = Math.max(0, posInt(spec.chairs) - extraSeats(spec));
    s.spt = posInt(s.spt) || 8; s.cols = posInt(s.cols) || 14; s.blocks = posInt(s.blocks) || 2; s.perLong = posInt(s.perLong) || 10;
    if (!need) return spec;
    if (s.style === 'rounds') s.tables = Math.ceil(need / s.spt);
    else if (s.style === 'theatre') s.rows = Math.ceil(need / (s.blocks * s.cols));
    else if (s.style === 'banquet') s.longTables = Math.ceil(need / s.perLong);
    else if (s.style === 'mixed') { const r = Math.ceil(need * 0.4 / s.spt); s.mixRounds = r; s.rows = Math.max(1, Math.ceil(Math.max(0, need - r * s.spt) / (s.blocks * s.cols))); }
    return spec;
  }

  /* ---------------- placement ---------------- */
  function layout(specIn, D) {
    const spec = JSON.parse(JSON.stringify(specIn));
    const A = D.ASSETS, W = +spec.hall.w, H = +spec.hall.h, cx = W / 2;
    const items = [], placed = [], warnings = [], missing = [];
    const hit = (a, b, g) => a.x < b.x + b.w + g && b.x < a.x + a.w + g && a.y < b.y + b.h + g && b.y < a.y + a.h + g;
    const inside = (r) => r.x >= -1e-6 && r.y >= -1e-6 && r.x + r.w <= W + 1e-6 && r.y + r.h <= H + 1e-6;
    const free = (r, g) => inside(r) && !placed.some((p) => hit(r, p, g == null ? 1 : g));
    const O = spec.objects || {};
    const on = (k) => O[k] && O[k].on;
    const qty = (k) => (OBJECTS[k].multi ? posInt(O[k].qty) : 1);
    const lbl = (k, i, n) => OBJECTS[k].label.replace(/s$/, '') + (n > 1 ? ' ' + (i + 1) : '');
    // drawn rect (dw×dh at rx,ry) → item; rot 90 swaps the item's own width/height
    function mk(type, r, rot, label, props, overlay) {
      const q = rot ? 90 : 0, w = q ? r.h : r.w, h = q ? r.w : r.h;
      const it = D.makeItem(type, r.x + r.w / 2 - w / 2, r.y + r.h / 2 - h / 2, { width: r1(w), height: r1(h), rotation: q, label });
      if (props) it.properties = Object.assign({}, it.properties || {}, props);
      items.push(it); if (!overlay) placed.push({ x: r.x, y: r.y, w: r.w, h: r.h });
      return it;
    }
    // try the preferred rect; else the nearest free spot (preferred region first, then the whole hall)
    function place(type, dw, dh, px, py, opt) {
      opt = opt || {}; dw = Math.min(dw, W); dh = Math.min(dh, H);
      let r = { x: clamp(px, 0, W - dw), y: clamp(py, 0, H - dh), w: dw, h: dh };
      const g = opt.gap == null ? 1 : opt.gap;
      if (!free(r, g)) {
        const step = Math.max(1, Math.round(Math.max(W, H) / 110));
        let best = null, bd = Infinity;
        const scan = (y0, y1) => { for (let y = Math.max(0, y0); y + dh <= Math.min(H, y1) + 1e-6; y += step) for (let x = 0; x + dw <= W + 1e-6; x += step) {
          const d = Math.abs(x - r.x) + Math.abs(y - r.y) * (opt.yw || 1); if (d >= bd) continue;
          const c = { x, y, w: dw, h: dh }; if (free(c, g)) { best = c; bd = d; } } };
        if (opt.region) scan(opt.region[0], opt.region[1]);
        if (!best) scan(0, H);
        if (!best) { missing.push(opt.label || type); return null; }
        r = best;
      }
      return mk(type, r, opt.rot, opt.label, opt.props);
    }
    const asz = (t) => ({ w: A[t].w, h: A[t].h });

    /* ---- 1. front centre stack: backdrop → truss → stage ---- */
    const st = on('stage') ? { w: clamp(+O.stage.w || 24, 6, W - 4), h: clamp(+O.stage.h || 10, 4, H * 0.35) } : null;
    let y = 1;
    for (const k of ['backdrop', 'brandwall', 'lighting']) {
      if (!on(k)) continue; const a = asz(OBJECTS[k].type), w = clamp(+O[k].w || a.w, 3, W - 4);
      if (place(OBJECTS[k].type, w, a.h, cx - w / 2, y, { label: OBJECTS[k].label, gap: 0.3 })) y += a.h + 0.5;
    }
    let stageR = null;
    if (st) { const it = place('stage', st.w, st.h, cx - st.w / 2, y, { label: 'Stage', gap: 0.3 }); if (it) stageR = placed[placed.length - 1]; }
    else if (on('mandap')) { const m = clamp(+O.mandap.w || 16, 6, W - 4), mh = clamp(+O.mandap.h || m, 6, H * 0.35);
      if (place('mandap', m, mh, cx - m / 2, y, { label: 'Mandap', gap: 0.3 })) stageR = placed[placed.length - 1]; }
    let frontBottom = stageR ? stageR.y + stageR.h : y;
    const sx0 = stageR ? stageR.x : cx - 6, sx1 = stageR ? stageR.x + stageR.w : cx + 6, sy = stageR ? stageR.y : y;
    // on-stage pieces (overlay: they stand ON the stage)
    if (stageR && st) {
      if (on('dais')) { const n = posInt(O.dais.seats) || 8, w = Math.min(n * 2.2, stageR.w - 2);
        const it = D.makeItem('chairrow', cx - w / 2, stageR.y + 1, { width: r1(w), height: 2, label: 'Dais seating', properties: { rows: 1, cols: n, onStage: true } }); items.push(it); }
      if (on('podium')) { const it = D.makeItem('podium', cx - 1.5, stageR.y + stageR.h - 4, { label: 'Podium', properties: { onStage: true } }); items.push(it); }
    } else if (on('podium')) place('podium', 3, 3, cx - 1.5, frontBottom + 2, { label: 'Podium' });
    // beside the stage: mandap (left), DJ (right), then line arrays + LED screens flanking outward
    let L = sx0, R = sx1;
    if (st && on('mandap')) { const m = clamp(+O.mandap.w || 16, 6, W * 0.3), mh = clamp(+O.mandap.h || m, 6, H * 0.35);
      const it = place('mandap', m, mh, L - 3 - m, sy, { label: 'Mandap', region: [0, H * 0.45] }); if (it && placed[placed.length - 1].x < L) L = placed[placed.length - 1].x; }
    if (on('dj')) { const a = asz('dj'); const it = place('dj', a.w, a.h, R + 3, sy + 1, { label: 'DJ console', region: [0, H * 0.45] }); if (it) { const p = placed[placed.length - 1]; if (p.x > R) R = p.x + p.w; } }
    if (on('linearray')) { const a = asz('linearray'), n = qty('linearray');
      for (let i = 0; i < n; i++) { const left = i % 2 === 0, tier = Math.floor(i / 2);
        const it = place('linearray', a.w, a.h, left ? L - 2 - a.w - tier * (a.w + 1.5) : R + 2 + tier * (a.w + 1.5), sy + 1, { label: 'Line array ' + (left ? 'L' : 'R') + (tier ? tier + 1 : ''), region: [0, H * 0.45] });
        if (it) { const p = placed[placed.length - 1]; if (left) L = Math.min(L, p.x); else R = Math.max(R, p.x + p.w); } } }
    if (on('led')) { const n = qty('led'), w = clamp(+O.led.w || 12, 3, W * 0.3), h = A.led.h;
      for (let i = 0; i < n; i++) { const left = i % 2 === 0, tier = Math.floor(i / 2);
        place('led', w, h, left ? L - 3 - w - tier * (w + 2) : R + 3 + tier * (w + 2), sy + 1, { label: 'LED screen ' + (i + 1), region: [0, H * 0.45] }); } }
    // flower decor along the stage front corners
    if (on('floral')) { const n = qty('floral'), a = asz('floral');
      for (let i = 0; i < n; i++) { const left = i % 2 === 0, k = Math.floor(i / 2);
        place('floral', a.w, a.h, left ? sx0 + k * (a.w + 1.5) : sx1 - a.w - k * (a.w + 1.5), frontBottom + 1, { label: 'Flower decor ' + (i + 1), gap: 0.5, region: [0, H * 0.5] }); }
      frontBottom += 4; }

    /* ---- 2. pit: barricade, walkway, dance floor / standing zone ---- */
    const hasWalk = on('walkway');
    if (hasWalk) { const ww = clamp(+O.walkway.w || 4, 3, 12), wl = clamp(+O.walkway.h || 10, 4, H * 0.3);
      if (place('walkway', ww, wl, cx - ww / 2, frontBottom + 0.2, { label: 'Walkway', gap: 0.1, region: [0, H * 0.6] })) frontBottom = Math.max(frontBottom, placed[placed.length - 1].y + placed[placed.length - 1].h); }
    if (on('barricade')) { const by = (stageR ? stageR.y + stageR.h : frontBottom) + 3, half = hasWalk ? 3 : 0;
      const span = clamp((stageR ? stageR.w : W * 0.4) + 10, 10, W - 4), bh = A.barricade.h;
      if (half) { const bw = span / 2 - half; place('barricade', bw, bh, cx - half - bw, by, { label: 'Barricade L', gap: 0.5 }); place('barricade', bw, bh, cx + half, by, { label: 'Barricade R', gap: 0.5 }); }
      else place('barricade', span, bh, cx - span / 2, by, { label: 'Barricade', gap: 0.5 });
      frontBottom = Math.max(frontBottom, by + bh); }
    for (const k of ['dancefloor', 'standing']) {
      if (!on(k)) continue; const w = clamp(+O[k].w || 20, 6, W - 4), h = clamp(+O[k].h || 20, 6, H * 0.45);
      const it = place('dancefloor', w, h, cx - w / 2, frontBottom + 3, { label: k === 'standing' ? 'Standing zone' : 'Dance floor', region: [0, H * 0.7], yw: 0.5 });
      if (it) { const p = placed[placed.length - 1]; frontBottom = Math.max(frontBottom, p.y + p.h);
        if (on('caketable')) { const a = asz('caketable'); place('caketable', a.w, a.h, p.x + p.w + 3, p.y + 1, { label: 'Cake table', region: [0, H * 0.7] }); } } }
    if (on('caketable') && !items.some((i) => i.type === 'caketable')) { const a = asz('caketable'); place('caketable', a.w, a.h, sx1 + 3, frontBottom + 2, { label: 'Cake table', region: [0, H * 0.7] }); }

    /* ---- 3. back wall: exits, entrance, FOH, service corners ---- */
    const ex = asz('exit'), nEx = on('exit') ? qty('exit') : 0;
    const exitSpots = [[1, H - ex.h - 1, 0], [W - ex.w - 1, H - ex.h - 1, 0], [1, H * 0.55, 90], [W - ex.h - 1, H * 0.55, 90], [1, H * 0.3, 90], [W - ex.h - 1, H * 0.3, 90]];
    for (let i = 0; i < nEx; i++) { const s = exitSpots[i % exitSpots.length], rot = s[2], dw = rot ? ex.h : ex.w, dh = rot ? ex.w : ex.h;
      place('exit', dw, dh, s[0], s[1], { label: i < 2 ? 'Exit' : 'Emergency exit', rot, gap: 0.5 }); }
    let entR = null;
    if (on('entrance')) { const a = asz('arch'); if (place('arch', a.w, a.h, cx - a.w / 2, H - a.h - 1, { label: 'Entrance', gap: 0.5 })) entR = placed[placed.length - 1]; }
    let backTop = H - Math.max(ex.h + 2, 4);
    const bandY = (h) => H - h - 1;
    if (on('foh')) { const a = asz('foh'), fy = (entR ? entR.y : H) - a.h - 8;
      if (place('foh', a.w, a.h, cx - a.w / 2, fy, { label: 'FOH console', region: [H * 0.5, H] })) backTop = Math.min(backTop, placed[placed.length - 1].y); }
    if (on('generator')) { const a = asz('generator'); place('generator', a.w, a.h, ex.w + 3, bandY(a.h), { label: 'Generator', region: [H * 0.6, H] }); }
    if (on('gifttable')) { const a = asz('gifttable'); place('gifttable', a.w, a.h, cx - (entR ? entR.w / 2 : 6) - a.w - 3, bandY(a.h), { label: 'Gift table', region: [H * 0.6, H] }); }
    if (on('desk')) { const a = asz('desk'), n = qty('desk');
      for (let i = 0; i < n; i++) place('desk', a.w, a.h, cx + (entR ? entR.w / 2 : 6) + 3 + i * (a.w + 2), bandY(a.h), { label: 'Registration ' + (n > 1 ? i + 1 : ''), region: [H * 0.6, H] }); }
    if (on('restroom')) { const a = asz('restroom'), n = qty('restroom');
      for (let i = 0; i < n; i++) place('restroom', a.w, a.h, W - ex.w - 3 - a.w - (i >> 1) * (a.w + 2), i % 2 ? bandY(a.h) - a.h - 3 : bandY(a.h), { label: 'Restrooms ' + (i + 1), region: [H * 0.55, H] }); }
    if (on('firstaid')) { const a = asz('firstaid'); place('firstaid', a.w, a.h, 1, H - ex.h - a.h - 4, { label: 'First aid', region: [H * 0.5, H] }); }
    if (on('cocktail')) { const a = asz('cocktail'), n = qty('cocktail'), per = Math.max(1, Math.floor((W * 0.5) / (a.w + 5)));
      for (let i = 0; i < n; i++) { const r = Math.floor(i / per), c = i % per, rowW = Math.min(per, n - r * per) * (a.w + 5) - 5;
        place('cocktail', a.w, a.h, cx - rowW / 2 + c * (a.w + 5), H - ex.h - 6 - a.h - r * (a.h + 5), { label: 'Cocktail table ' + (i + 1), gap: 1.5, region: [H * 0.55, H], props: { seats: 0 } }); } }

    /* ---- 4. side walls ---- */
    if (on('buffet')) { const a = asz('buffet'), n = qty('buffet');
      for (let i = 0; i < n; i++) place('buffet', a.h, a.w, W - a.h - 2, frontBottom + 3 + i * (a.w + 4), { label: 'Buffet ' + (n > 1 ? i + 1 : ''), rot: 90 }); }
    if (on('bar')) { const a = asz('bar'), n = qty('bar');
      for (let i = 0; i < n; i++) place('bar', a.h, a.w, 2, H - ex.h - 4 - a.w - i * (a.w + 4), { label: 'Bar ' + (n > 1 ? i + 1 : ''), rot: 90 }); }
    if (on('photobooth')) { const a = asz('photobooth'); place('photobooth', a.w, a.h, 2, frontBottom + 3, { label: 'Photo booth' }); }
    if (on('press')) { const a = asz('press'), w = Math.min(a.w, W * 0.2), h = Math.min(a.h, H * 0.15); place('press', w, h, W - w - 2, frontBottom + 3, { label: 'Press area' }); }
    items.forEach((it) => { if (it.label) it.label = String(it.label).trim(); });

    /* ---- 5. VIP: sofas / rows either side of the centre aisle, right behind the front zone ---- */
    const aisle = clamp(+spec.seating.aisle || 6, 3, 30);
    let vipBottom = frontBottom;
    const vipUnits = [];
    if (on('vipsofa')) for (let i = 0; i < qty('vipsofa'); i++) vipUnits.push({ type: 'sofa', w: A.sofa.w, h: A.sofa.h, label: 'VIP sofa ' + (i + 1), props: { seats: 3 } });
    if (on('viprow')) { const n = posInt(O.viprow.seats) || 12; for (let i = 0; i < qty('viprow'); i++) vipUnits.push({ type: 'chairrow', w: r1(n * 2.2), h: 2, label: 'VIP row ' + (i + 1), props: { rows: 1, cols: n } }); }
    if (vipUnits.length) {
      let yL = frontBottom + 3, yR = frontBottom + 3, xL = cx - aisle / 2, xR = cx + aisle / 2;
      vipUnits.forEach((u, i) => { const left = i % 2 === 0;
        let px = left ? xL - u.w : xR, py = left ? yL : yR;
        if ((left && px < 2) || (!left && px + u.w > W - 2)) { if (left) { yL += u.h + 2; xL = cx - aisle / 2; px = xL - u.w; py = yL; } else { yR += u.h + 2; xR = cx + aisle / 2; px = xR; py = yR; } }
        const it = place(u.type, u.w, u.h, px, py, { label: u.label, props: u.props, gap: 0.8, region: [frontBottom, H * 0.8] });
        if (it) { const p = placed[placed.length - 1]; vipBottom = Math.max(vipBottom, p.y + p.h);
          if (Math.abs(p.y - py) < 0.01) { if (left) xL = p.x - 1.5; else xR = p.x + p.w + 1.5; } } });
    }

    /* ---- 6. optional aisle carpet: entrance → front of the aisle only ---- */
    if (spec.carpet) {
      const cw = clamp(aisle - 2, 3, 6), lane = { x: cx - cw / 2, w: cw };
      const bottom = entR ? entR.y - 0.3 : H - 1;
      // the carpet stops at the first thing in the centre lane coming up from the entrance
      let top = Math.max(frontBottom + 1, 0);
      placed.forEach((p) => { if (p.x < lane.x + lane.w && lane.x < p.x + p.w && p.y + p.h <= bottom + 1e-6) top = Math.max(top, p.y + p.h + 0.3); });
      if (bottom - top >= 4) mk('redcarpet', { x: lane.x, y: top, w: cw, h: bottom - top }, 0, 'Aisle carpet');
      else warnings.push('No clear centre aisle for the carpet — it was left out.');
    }

    /* ---- 7. main seating in the zone left between the front and the back band ---- */
    const plan = seatPlan(spec), s = spec.seating;
    const zTop = Math.max(frontBottom, vipBottom) + 3;
    let zBot = backTop - 2;
    placed.forEach((p) => { if (p.y > zTop + (H - zTop) * 0.45 && p.x < cx + aisle && p.x + p.w > cx - aisle) zBot = Math.min(zBot, p.y - 2); });   // FOH / entrance band
    let mainLeft = plan.main, mainPlaced = 0;
    const seatGap = 1.5;
    function gridCells(cw, ch, px, py, y0, y1) {
      // cells either side of the centre aisle, rows top-down, nearest the aisle first
      const out = [], maxC = Math.floor((W / 2 - aisle / 2 - 1) / px) + 1;
      // B7: only mirrored pairs (left + right both free) so the room stays balanced around the aisle
      for (let yy = y0; yy + ch <= y1 + 1e-6; yy += py) for (let c = 0; c < maxC; c++) {
        const l = { x: cx - aisle / 2 - cw - c * px, y: yy, w: cw, h: ch }, r = { x: cx + aisle / 2 + c * px, y: yy, w: cw, h: ch };
        if (l.x < 1 || r.x + r.w > W - 1) continue;
        if (free(l, seatGap) && free(r, seatGap)) out.push(l, r); }
      return out;
    }
    // live-round2 C2: a balanced grid shaped to the seating zone. cols-per-side x rows is chosen so the
    // grid's aspect matches the zone's (not "as many columns as the width allows" = 2 long rows with
    // empty bands), at a comfortable pitch (table + gap, then tighter), stretched up to 1.6x to fill
    // the zone, mirrored about the centre aisle and centred in the zone.
    function balancedCells(n, cw, ch, gapX, gapY, y0, y1) {
      const Wa = W / 2 - aisle / 2 - 1, Dz = y1 - y0, pairs = Math.ceil(n / 2);
      if (Wa < cw || Dz < ch || pairs < 1) return [];
      for (const k of [1, 0.75, 0.5]) {
        const px0 = cw + gapX * k, py0 = ch + gapY * k;
        const Cmax = Math.floor((Wa - cw) / px0) + 1, Rmax = Math.floor((Dz - ch) / py0) + 1;
        if (Cmax < 1 || Rmax < 1 || Cmax * Rmax < pairs) continue;
        const zoneAsp = (2 * Wa + aisle) / Dz;
        let pick = null;
        for (let c = 1; c <= Cmax; c++) { const R = Math.ceil(pairs / c); if (R > Rmax) continue;
          const px = c > 1 ? Math.min(px0 * 1.6, Math.max(px0, (Wa - cw) / (c - 1))) : px0, py = R > 1 ? Math.min(py0 * 1.6, Math.max(py0, (Dz - ch) / (R - 1))) : py0;
          const gw = 2 * ((c - 1) * px + cw) + aisle, gd = (R - 1) * py + ch;
          const sc = Math.abs(Math.log((gw / gd) / zoneAsp)) + 0.04 * (c * R - pairs) + 0.5 * Math.max(0, 1 - gd / Dz) + 0.5 * Math.max(0, 1 - gw / (2 * Wa + aisle));
          if (!pick || sc < pick.sc) pick = { c, R, px, py, gd, sc }; }
        if (!pick) continue;
        const bw = (pick.c - 1) * pick.px + cw, off = Math.max(0, Math.min(pick.px, (Wa - bw) / 2));
        const ys = y0 + Math.max(0, (Dz - pick.gd) / 2), out = [];
        for (let r = 0; r < pick.R; r++) for (let c = 0; c < pick.c; c++) {
          const yy = ys + r * pick.py;
          const l = { x: cx - aisle / 2 - off - cw - c * pick.px, y: yy, w: cw, h: ch }, rr = { x: cx + aisle / 2 + off + c * pick.px, y: yy, w: cw, h: ch };
          if (l.x < 1 || rr.x + rr.w > W - 1) continue;
          if (free(l, seatGap) && free(rr, seatGap)) out.push(l, rr); }
        if (out.length >= n) {
          // the last (partial) row keeps its tables nearest the aisle, mirrored
          return out.slice(0, n);
        }
      }
      return [];
    }
    function tablesIn(n, cw, ch, gapX, gapY, y0, y1) {
      const bal = balancedCells(n, cw, ch, gapX, gapY, y0, y1); if (bal.length >= n) return bal;
      // fallback (busy zone): try comfortable spacing, centred in the zone; then tighter; then from the top
      let best = [];
      for (const k of [1, 0.75, 0.5]) { const px = cw + gapX * k, py = ch + gapY * k;
        const rowsNeed = Math.ceil(n / Math.max(1, 2 * (Math.floor((W / 2 - aisle / 2 - 1) / px) + 1)));
        const used = rowsNeed * py, yc = y0 + Math.max(0, ((y1 - y0) - used) / 2);
        for (const ys of [yc, y0]) { const c = gridCells(cw, ch, px, py, ys, y1); if (c.length > best.length) best = c; if (best.length >= n) return best.slice(0, n); } }
      return best.slice(0, n);
    }
    let tableNo = 0, lastTables = 0, longNo = 0;
    function roundTables(nT, spt, seats, y0, y1) {
      const d = spt <= 6 ? 5 : spt <= 10 ? 6 : spt <= 12 ? 7 : 8;
      const cells = tablesIn(nT > 1 && nT % 2 ? nT + 1 : nT, d, d, 4, 4, y0, y1);   // B7: even count = mirrored pairs
      const n = cells.length, give = Math.min(seats, n * spt);
      const base = n ? Math.floor(give / n) : 0, extra = n ? give % n : 0;
      let lastY = y0;
      cells.forEach((r, i) => { const k = base + (i < extra ? 1 : 0); if (k <= 0) return;
        mk('table', r, 0, 'T' + (++tableNo), { seats: k }); lastY = Math.max(lastY, r.y + r.h); });
      mainPlaced += give; lastTables = n; return lastY;
    }
    function theatre(B, Rw, C, seats, y0, y1) {
      const P = 2.4, RP = 3, bw = C * P;
      let left = seats, yy = y0, made = 0;
      const i0 = items.length, p0 = placed.length, bandOf = [];   // C2: for the spread/centre pass below
      let perBand = Math.max(1, Math.min(B, Math.floor((W - 4 + aisle) / (bw + aisle))));
      // B7: blocks come in mirrored pairs around the centre aisle (= stage / walkway centre line)
      if (perBand > 1 && perBand % 2) perBand--;
      const rowsPerBlock = Math.max(1, Rw);
      let bandNo = 0;
      const xOf = (j, m) => { if (m === 1) return bandNo % 2 ? cx + aisle / 2 : cx - aisle / 2 - bw;   // one block per band: alternate sides
        const nl = Math.ceil(m / 2), isL = j < nl, k = isL ? nl - 1 - j : j - nl;
        return isL ? cx - aisle / 2 - (k + 1) * bw - k * aisle : cx + aisle / 2 + k * (bw + aisle); };
      while (left > 0 && made < B * 3 && yy + RP <= y1 + 1e-6) {
        let m = Math.min(perBand, made < B ? B - made : perBand);
        if (m > 1 && m % 2) m--;
        // seats per block: even split, mirrored pairs get the same count (remainder goes to the pairs nearest the aisle)
        const share = (mm, rowsCap) => { const tot = Math.min(left, mm * rowsCap * C), out = new Array(mm).fill(Math.floor(tot / mm)); let r = tot - out[0] * mm;
          const nl = Math.ceil(mm / 2), order = []; for (let k = 0; k < nl; k++) { order.push(nl - 1 - k); if (nl + k < mm) order.push(nl + k); }
          for (let i = 0; r > 0; i = (i + 1) % order.length) { if (out[order[i]] < rowsCap * C) { out[order[i]]++; r--; } }
          return out; };
        // one common top edge for the whole band so the halves line up; most rows first
        let band = null;
        for (let rows = Math.min(rowsPerBlock, Math.ceil(left / (m * C))); rows >= 1 && !band; rows--)
          for (let ty = yy; ty + rows * RP <= y1 + 1e-6 && !band; ty += 1) {
            let ok = true; for (let j = 0; j < m && ok; j++) ok = free({ x: xOf(j, m), y: ty, w: bw, h: rows * RP }, seatGap);
            if (ok) band = { ty, rows }; }
        // no common edge: each mirrored block may slide down on its own (still the same seats each side)
        if (!band && m > 1) for (let rows = Math.min(rowsPerBlock, Math.ceil(left / (m * C))); rows >= 1 && !band; rows--) {
          const per = Math.ceil(Math.min(left, m * rows * C) / m), uw = Math.min(bw, Math.ceil(per / rows) * P);
          const tys = []; for (let j = 0; j < m; j++) { let got = null; const bx = xOf(j, m) + (bw - uw) / 2;
            for (let ty = yy; ty + rows * RP <= y1 + 1e-6; ty += 1) if (free({ x: bx, y: ty, w: uw, h: rows * RP }, seatGap)) { got = ty; break; }
            if (got == null) break; tys.push(got); }
          if (tys.length === m) band = { ty: tys[0], tys, rows };
        }
        if (!band) {
          if (m > 1) { perBand = Math.max(1, perBand - 2); if (perBand < 1) break; continue; }
          made++; yy += RP; continue;
        }
        const counts = share(m, band.rows); let bandBottom = yy;
        for (let j = 0; j < m; j++) {
          const n = counts[j]; made++; if (n <= 0) continue;
          const x = xOf(j, m), ty = band.tys ? band.tys[j] : band.ty, fullRows = Math.floor(n / C), rem = n % C;
          if (fullRows) { mk('seatblock', { x, y: ty, w: bw, h: fullRows * RP }, 0, 'Seating block ' + made, { rows: fullRows, cols: C }); bandOf.push(bandNo); }
          // partial last row: centred under its block
          if (rem) bandOf.push(bandNo);
          if (rem) mk('chairrow', { x: x + (bw - rem * P) / 2, y: ty + fullRows * RP + 0.2, w: rem * P, h: 2 }, 0, 'Seating block ' + made + ' · last row', { rows: 1, cols: rem });
          left -= n; mainPlaced += n; bandBottom = Math.max(bandBottom, ty + fullRows * RP + (rem ? 2.2 : 0));
        }
        yy = bandBottom > yy ? bandBottom + aisle : yy + RP; bandNo++;
      }
      spreadBands(i0, p0, bandOf, y0, y1);
      return yy;
    }
    // live-round2 C2: theatre bands were stacked from the top of the zone, leaving the back half empty.
    // Open the cross-aisles between bands (up to +8 ft each) and centre the whole group in the zone -
    // only when every moved block stays inside the zone and collision-free (else nothing moves).
    function spreadBands(i0, p0, bandOf, y0, y1) {
      const mine = items.slice(i0), rects = placed.slice(p0);
      if (!mine.length || rects.length !== mine.length || bandOf.length !== mine.length) return;
      const top = Math.min(...rects.map((r) => r.y)), bot = Math.max(...rects.map((r) => r.y + r.h));
      const nb = Math.max(...bandOf) + 1, slack = y1 - bot;
      if (slack <= 1) return;
      const others = placed.slice(0, p0);
      const okAt = (extra, base) => rects.every((r, i) => { const q = { x: r.x, y: r.y + base + bandOf[i] * extra, w: r.w, h: r.h };
        return q.y >= y0 - 1e-6 && q.y + q.h <= y1 + 1e-6 && inside(q) && !others.some((o) => hit(q, o, seatGap)); });
      const tries = [];
      const ex0 = nb > 1 ? Math.min(8, slack * 0.6 / (nb - 1)) : 0;
      for (const ex of [ex0, ex0 / 2, 0]) { const used = bot - top + ex * (nb - 1); tries.push([ex, Math.max(0, (y0 + (y1 - y0 - used) / 2) - top)]); }
      for (const [ex, base] of tries) {
        if (!(ex > 0 || base > 0.5) || !okAt(ex, base)) continue;
        mine.forEach((it, i) => { const dy = base + bandOf[i] * ex; it.y += dy; rects[i].y += dy; });
        return;
      }
    }
    function banquet(nL, per, seats, y0, y1) {
      const len = Math.max(8, Math.min(30, Math.ceil(per / 2) * 2.2 + 1.5)), cells = tablesIn(nL > 1 && nL % 2 ? nL + 1 : nL, len, 4, 4, 6, y0, y1);
      const n = cells.length, give = Math.min(seats, n * per), base = n ? Math.floor(give / n) : 0, extra = n ? give % n : 0;
      cells.forEach((r, i) => { const k = base + (i < extra ? 1 : 0); if (k > 0) mk('longtable', r, 0, 'Banquet ' + (++longNo), { seats: k }); });
      mainPlaced += give; lastTables = n;
    }
    if (mainLeft > 0) {
      if (s.style === 'rounds') roundTables(posInt(s.tables), posInt(s.spt) || 8, mainLeft, zTop, zBot);
      else if (s.style === 'theatre') theatre(posInt(s.blocks) || 2, posInt(s.rows), posInt(s.cols) || 14, mainLeft, zTop, zBot);
      else if (s.style === 'banquet') banquet(posInt(s.longTables), posInt(s.perLong) || 10, mainLeft, zTop, zBot);
      else if (s.style === 'mixed') {
        const rs = Math.min(mainLeft, posInt(s.mixRounds) * (posInt(s.spt) || 8));
        const yEnd = rs ? roundTables(posInt(s.mixRounds), posInt(s.spt) || 8, rs, zTop, zBot - 6) : zTop;
        const rest = mainLeft - rs; if (rest > 0) theatre(posInt(s.blocks) || 2, posInt(s.rows), posInt(s.cols) || 14, rest, (rs ? yEnd : zTop) + 4, zBot);
      }
    }
    // small / busy halls: the clean band could not hold everything — use any free floor in front of the
    // back wall (beside the dance floor, along the sides), still collision-checked with walkways
    const stageBottom = stageR ? stageR.y + stageR.h + 2 : 2;
    if (mainPlaced < plan.main && s.style !== 'standing') {
      const rest = plan.main - mainPlaced;
      if (s.style === 'rounds' || (s.style === 'mixed' && posInt(s.mixRounds) > 0 && !items.some((i) => i.type === 'seatblock' || /Seating block/.test(i.label || '')))) {
        const spt = posInt(s.spt) || 8, want = s.style === 'rounds' ? posInt(s.tables) : posInt(s.mixRounds);
        roundTables(Math.max(1, want - tableNo), spt, Math.min(rest, Math.max(1, want - tableNo) * spt), stageBottom, H - 1);
      } else if (s.style === 'banquet') { const per = posInt(s.perLong) || 10; banquet(Math.max(1, posInt(s.longTables) - longNo), per, rest, stageBottom, H - 1); }
      if (mainPlaced < plan.main && (s.style === 'theatre' || s.style === 'mixed')) theatre(posInt(s.blocks) || 2, posInt(s.rows), posInt(s.cols) || 14, plan.main - mainPlaced, stageBottom, H - 1);
    }
    const seats = D.genSeats ? items.reduce((n, it) => n + D.genSeats(it), 0) : null;
    const expected = plan.main + plan.extras;
    const fits = mainPlaced >= plan.main && !missing.length;
    if (mainPlaced < plan.main) {
      const f = Math.sqrt(Math.max(1, plan.main) / Math.max(1, mainPlaced || 1)) * 1.08;
      warnings.push(`Only ${mainPlaced.toLocaleString('en-IN')} of ${plan.main.toLocaleString('en-IN')} main seats fit in a ${W} × ${H} ft hall with this setup.`);
      warnings.push(`Try: a hall of about ${Math.ceil(W * Math.min(f, 4))} × ${Math.ceil(H * Math.min(f, 4))} ft` +
        (s.style === 'rounds' || s.style === 'banquet' ? ', theatre blocks (seat ~2× more per sq ft)' : '') +
        (on('dancefloor') || on('standing') ? ', a smaller dance floor / standing zone' : '') + `, or ${Math.max(0, mainPlaced + plan.extras).toLocaleString('en-IN')} seats.`);
    }
    if (missing.length) warnings.push('Could not fit: ' + missing.join(', ') + ' — enlarge the hall or untick them.');
    return { items, warnings, missing, seats, expected, mainPlaced, main: plan.main, extras: plan.extras, fits, zone: { top: zTop, bottom: zBot } };
  }

  // B7: what the theatre placement really draws: even split per block, last row partial
  function theatreText(s, main) {
    const B = posInt(s.blocks) || 2, C = posInt(s.cols) || 14, per = Math.floor(main / B), extra = main - per * B;
    const full = Math.floor(per / C), rem = per % C;
    return `${B} blocks × ${full} row${full === 1 ? '' : 's'} × ${C}` + (rem ? ` + ${rem}${extra ? '–' + (rem + 1) : ''} in a last row` : extra ? ` (+1 seat in ${extra} blocks)` : '') + ` = ${main} seats`;
  }
  const API = { typesFor, defaultUnit, theatreText, OBJECTS, TYPES, SEATING_STYLES, M2FT, typeKey, defaults, defaultSize, extraSeats, mainCapacity, seatPlan, fitSeating, layout };
  G.HelmWizard = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (typeof document === 'undefined' || !G.document) return;

  /* =====================================================================
     UI — 4 steps: ① Venue & guests ② Seating ③ Objects ④ Review & generate
     ===================================================================== */
  const doc = G.document;
  const el = (tag, cls, text, attrs) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; if (attrs) Object.entries(attrs).forEach(([k, v]) => { if (v != null) e.setAttribute(k, v); }); return e; };
  /* builder.js globals (classic-script top-level bindings; no eval — CSP) */
  /* eslint-disable no-undef */
  const GET = {
    ASSETS: () => (typeof ASSETS !== 'undefined' ? ASSETS : undefined),
    makeItem: () => (typeof makeItem !== 'undefined' ? makeItem : undefined),
    genSeats: () => (typeof genSeats !== 'undefined' ? genSeats : undefined),
    WORLD: () => (typeof WORLD !== 'undefined' ? WORLD : undefined),
    store: () => (typeof store !== 'undefined' ? store : undefined),
    PRICING: () => (typeof PRICING !== 'undefined' ? PRICING : undefined),
    currentClient: () => (typeof currentClient !== 'undefined' ? currentClient : undefined),
    currentQuoteId: () => (typeof currentQuoteId !== 'undefined' ? currentQuoteId : undefined),
    quoteChairsNow: () => (typeof quoteChairsNow !== 'undefined' ? quoteChairsNow : undefined),
    updateDimsLabel: () => (typeof updateDimsLabel !== 'undefined' ? updateDimsLabel : undefined),
    sizeCanvas: () => (typeof sizeCanvas !== 'undefined' ? sizeCanvas : undefined),
    loadItems: () => (typeof loadItems !== 'undefined' ? loadItems : undefined),
    persistSizing: () => (typeof persistSizing !== 'undefined' ? persistSizing : undefined),
    persistGuests: () => (typeof persistGuests !== 'undefined' ? persistGuests : undefined),
    renderAll: () => (typeof renderAll !== 'undefined' ? renderAll : undefined),
    fitView: () => (typeof fitView !== 'undefined' ? fitView : undefined),
    renderPrice: () => (typeof renderPrice !== 'undefined' ? renderPrice : undefined),
    toast: () => (typeof toast !== 'undefined' ? toast : undefined),
    openCustomModal: () => (typeof openCustomModal !== 'undefined' ? openCustomModal : undefined),
  };
  /* eslint-enable no-undef */
  const g = (name) => { try { return GET[name] ? GET[name]() : undefined; } catch (_) { return undefined; } };
  let spec = null, step = 0, opener = null, lastResult = null;
  const studioCountry = () => { try { return (G.BPStore && G.BPStore.studioTax && G.BPStore.studioTax().country) || 'IN'; } catch (_) { return 'IN'; } };
  const STEPS = ['Venue & guests', 'Seating', 'Objects', 'Review'];
  const memKey = () => { const q = g('currentQuoteId'); return 'helm.layoutWizard.v1.' + (q || 'draft'); };
  const remember = () => { try { G.localStorage.setItem(memKey(), JSON.stringify(spec)); } catch (_) {} };
  const recall = () => { try { const s = JSON.parse(G.localStorage.getItem(memKey()) || 'null'); return s && s.objects && s.seating && s.hall ? s : null; } catch (_) { return null; } };
  const U = () => (spec.unit === 'm' ? 'm' : 'ft');
  const toU = (ft) => (spec.unit === 'm' ? Math.round(ft / M2FT * 10) / 10 : Math.round(ft * 10) / 10);
  const fromU = (v) => { const n = +v; if (!isFinite(n) || n <= 0) return null; return spec.unit === 'm' ? n * M2FT : n; };

  const modal = el('div', 'modal lw-modal', null, { id: 'wizModal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'wizTitle' }); modal.hidden = true;
  const sheet = el('div', 'sheet lw-sheet');
  const head = el('div', 'sheet-head lw-head');
  const ttl = el('b', null, '✨ Create layout', { id: 'wizTitle' });
  const bClose = el('button', 'tbtn icon', '✕', { type: 'button', 'aria-label': 'Close layout wizard', title: 'Close' });
  head.append(ttl, bClose);
  const stepper = el('ol', 'lw-steps', null, { 'aria-label': 'Steps' });
  const body = el('div', 'sheet-body lw-body');
  const foot = el('div', 'lw-foot');
  const live = el('div', 'lw-live', null, { 'aria-live': 'polite', id: 'wizLive' });
  const bBack = el('button', 'tbtn', '← Back', { type: 'button' });
  const bNext = el('button', 'tbtn primary', 'Next →', { type: 'button', id: 'wizNext' });
  const bClassic = el('button', 'tbtn lw-classic', 'Classic templates…', { type: 'button', title: 'Open the previous template-based Custom Event dialog' });
  // 0096: the studio's own saved templates (studio-templates.js), shown only when the studio has some
  const bMine = el('button', 'tbtn lw-mine', 'Start from my template', { type: 'button', id: 'wizMine', title: "Use one of your studio's own layout templates (fitted to this hall)" });
  bMine.hidden = true;
  const nav = el('div', 'lw-nav'); nav.append(bMine, bClassic, bBack, bNext);
  foot.append(live, nav);
  sheet.append(head, stepper, body, foot); modal.append(sheet);

  function field(label, input, hint) { const l = el('label', 'lw-field'); l.append(el('span', 'lw-lbl', label), input); if (hint) l.append(el('small', 'lw-hint', hint)); return l; }
  function num(val, min, max, onInput, attrs) {
    const i = el('input', 'lw-in', null, Object.assign({ type: 'number', inputmode: 'decimal', min: String(min), max: String(max), step: 'any' }, attrs || {}));
    i.value = val == null || val === 0 ? '' : String(val);
    i.addEventListener('input', () => { onInput(i.value); renderLive(); });
    return i;
  }
  function seg(options, cur, onPick, label) {
    const s = el('div', 'seg lw-seg', null, { role: 'radiogroup', 'aria-label': label });
    Object.entries(options).forEach(([k, t]) => { const b = el('button', k === cur ? 'on' : '', t, { type: 'button', role: 'radio', 'aria-checked': String(k === cur) });
      b.addEventListener('click', () => { onPick(k); }); s.append(b); });
    return s;
  }

  function renderSteps() {
    stepper.replaceChildren(...STEPS.map((t, i) => { const li = el('li', 'lw-step' + (i === step ? ' on' : '') + (i < step ? ' done' : ''));
      const b = el('button', null, null, { type: 'button', 'aria-current': i === step ? 'step' : null }); b.append(el('span', 'lw-n', String(i + 1)), el('span', 'lw-t', t));
      b.addEventListener('click', () => go(i)); li.append(b); return li; }));
    bBack.disabled = step === 0; bNext.textContent = step === 3 ? 'Place on floor' : 'Next →';
    bNext.classList.toggle('lw-go', step === 3);
  }
  function renderLive() {
    const p = seatPlan(spec);
    live.replaceChildren();
    const ok = p.match;
    const chip = el('span', 'lw-total ' + (ok ? 'ok' : 'warn'));
    chip.append(el('b', null, p.total.toLocaleString('en-IN')), el('span', null, ' seats'));
    live.append(chip);
    const t = p.target ? (ok ? ` = target ${p.target.toLocaleString('en-IN')} ✓` : ` · target ${p.target.toLocaleString('en-IN')} (${p.total < p.target ? (p.target - p.total) + ' short' : (p.total - p.target) + ' over'})`) : '';
    live.append(el('span', 'lw-sub', `${p.main} main + ${p.extras} VIP/stage${t}`));
  }
  function renderBody() {
    body.replaceChildren();
    const panel = el('div', 'lw-panel', null, { role: 'group', 'aria-label': STEPS[step] });
    if (step === 0) stepVenue(panel); else if (step === 1) stepSeating(panel); else if (step === 2) stepObjects(panel); else stepReview(panel);
    body.append(panel); renderSteps(); renderLive();
  }
  function stepVenue(p) {
    p.append(el('p', 'lw-note', 'Tell us the event and the hall. Everything is prefilled from the quote — change anything.'));
    const typeSel = el('select', 'lw-in', null, { id: 'wizType' });
    const tl = typesFor(studioCountry()); if (!tl.some((x) => x.key === spec.type)) tl.push({ key: spec.type, label: TYPES[spec.type].label });
    tl.forEach(({ key: k, label }) => { const o = el('option', null, label, { value: k }); if (k === spec.type) o.selected = true; typeSel.append(o); });
    typeSel.addEventListener('change', () => { const keep = { guests: spec.guests, chairs: spec.chairs, w: spec.hall.w, h: spec.hall.h, unit: spec.unit, country: studioCountry() };
      const carpet = spec.carpet; spec = defaults(typeSel.value, keep); spec.carpet = carpet; renderBody(); });
    const grid = el('div', 'lw-grid');
    grid.append(field('Event type', typeSel, 'Picks the suggested objects & seating'));
    grid.append(field('Saved venue', venueSel(), 'Fills the hall size; restrictions show in Classic templates'));
    const unit = seg({ ft: 'Feet', m: 'Metres' }, spec.unit, (k) => { spec.unit = k; renderBody(); }, 'Units');
    grid.append(field('Units', unit));
    grid.append(field('Hall length (' + U() + ')', num(toU(spec.hall.w), 1, 3000, (v) => { const f = fromU(v); if (f) spec.hall.w = clamp(Math.round(f), 20, 1000); refit(true); }, { id: 'wizLen' })));
    grid.append(field('Hall width (' + U() + ')', num(toU(spec.hall.h), 1, 3000, (v) => { const f = fromU(v); if (f) spec.hall.h = clamp(Math.round(f), 20, 1000); refit(true); }, { id: 'wizWid' })));
    const chairsIn = num(spec.chairs, 1, 20000, (v) => { spec.chairs = posInt(v); spec._chairsManual = v !== ''; refit(); }, { id: 'wizChairs', step: '1' });
    grid.append(field('Expected guests', num(spec.guests, 0, 20000, (v) => { spec.guests = posInt(v); if (!spec._chairsManual) { spec.chairs = spec.guests ? Math.ceil(spec.guests * 7 / 10) : 0; chairsIn.value = spec.chairs || ''; } refit(); }, { id: 'wizGuests', step: '1' })));
    grid.append(field('Seats needed', chairsIn, '70% of guests by default — every seat counts (VIP, stage, sofas)'));
    p.append(grid);
  }
  // "Saved venue": pick one of the studio's venues -> hall length / width (ft) + link it to the event
  let venueRows = null, venuePicked = '';
  function venueSel() {
    const sel = el('select', 'lw-in', null, { id: 'wizVenue', 'aria-label': 'Saved venue' });
    sel.append(el('option', null, '- type the hall size by hand -', { value: '' }));
    const B = window.HelmBuilderVenue, linkedId = venuePicked || (B && B.client && B.client().venueId) || '';
    const fill = (rows) => {
      (rows || []).forEach((v) => { const o = el('option', null, v.name + (v.city ? ' - ' + v.city : ''), { value: v.id }); if (v.id === linkedId) o.selected = true; sel.append(o); });
      sel.disabled = !(rows || []).length;
    };
    if (venueRows) fill(venueRows);
    else { sel.disabled = true; const S = window.BPStore;
      if (S && S.venues && S.venues.list) S.venues.list().then((r) => { venueRows = r || []; fill(venueRows); }).catch(() => {}); }
    sel.addEventListener('change', () => {
      venuePicked = sel.value;
      const v = (venueRows || []).find((x) => x.id === sel.value), V = window.HelmVenues;
      if (B && B.link) B.link(v || null);
      if (!v || !V || !V.fillFor) return;
      const f = V.fillFor(v);
      if (f.lenFt) spec.hall.w = clamp(Math.round(f.lenFt), 20, 1000);
      if (f.widFt) spec.hall.h = clamp(Math.round(f.widFt), 20, 1000);
      refit(true); renderBody();
    });
    return sel;
  }
  // the seating counts follow guests / chairs / hall until the user types their own seating numbers
  function refit(hall) {
    if (spec._seatManual) return;
    if (hall) { const s = spec.seating, d = defaults(spec.type, { w: spec.hall.w, h: spec.hall.h }).seating; s.blocks = d.blocks; s.cols = d.cols; }
    fitSeating(spec);
  }
  function stepSeating(p) {
    const s = spec.seating;
    p.append(el('p', 'lw-note', 'Choose the seating style and the exact counts. The total updates live below.'));
    p.append(field('Seating style', seg(SEATING_STYLES, s.style, (k) => { s.style = k; fitSeating(spec); renderBody(); }, 'Seating style')));
    const grid = el('div', 'lw-grid');
    const n = (label, key, min, max, hint) => grid.append(field(label, num(s[key], min, max, (v) => { s[key] = posInt(v); spec._seatManual = true; }, { step: '1', 'data-k': key }), hint));
    if (s.style === 'rounds' || s.style === 'mixed') { n(s.style === 'mixed' ? 'Round tables (front)' : 'Round tables', s.style === 'mixed' ? 'mixRounds' : 'tables', 0, 2000, 'Default = seats ÷ 8'); n('Seats per table', 'spt', 2, 16); }
    if (s.style === 'theatre' || s.style === 'mixed') { n('Blocks', 'blocks', 1, 40); n('Rows per block', 'rows', 1, 200); n('Seats per row', 'cols', 1, 80); }
    if (s.style === 'banquet') { n('Long tables', 'longTables', 0, 1000); n('Seats per long table', 'perLong', 4, 24); }
    if (s.style !== 'standing') grid.append(field('Aisle width (ft)', num(s.aisle, 3, 30, (v) => { s.aisle = clamp(posInt(v) || 6, 3, 30); }, { step: '1' }), 'Centre aisle facing the stage'));
    p.append(grid);
    if (s.style === 'standing') p.append(el('p', 'lw-note', 'No main seating — guests stand in the standing zone. VIP sofas still count as seats.'));
    else { const fit = el('button', 'tbtn', '⟳ Match seats to target', { type: 'button' });
      fit.addEventListener('click', () => { spec._seatManual = false; fitSeating(spec); renderBody(); }); p.append(fit); }
  }
  function stepObjects(p) {
    p.append(el('p', 'lw-note', `Suggested for a ${TYPES[spec.type].label.toLowerCase()} — preselected. Required items are locked on.`));
    const list = el('div', 'lw-objs');
    Object.entries(spec.objects).forEach(([k, o]) => {
      const c = OBJECTS[k]; const row = el('div', 'lw-obj' + (o.on ? ' on' : ''));
      const id = 'wizo_' + k;
      const cb = el('input', null, null, { type: 'checkbox', id }); cb.checked = !!o.on; cb.disabled = !!o.mandatory;
      cb.addEventListener('change', () => { o.on = cb.checked; row.classList.toggle('on', o.on); refit(); renderLive(); });
      const lab = el('label', 'lw-oname', null, { for: id }); lab.append(cb, el('span', null, c.label));
      if (o.mandatory) lab.append(el('span', 'lw-req', 'Required'));
      row.append(lab);
      const ctl = el('div', 'lw-octl');
      if (c.multi) ctl.append(field('Qty', num(o.qty, 1, 200, (v) => { o.qty = posInt(v) || 1; refit(); }, { step: '1', 'aria-label': c.label + ' quantity' })));
      if (c.seatsField) ctl.append(field('Seats', num(o.seats, 1, 200, (v) => { o.seats = posInt(v) || 1; refit(); }, { step: '1', 'aria-label': c.label + ' seats' })));
      if (c.size === 'wh' || c.size === 'w') ctl.append(field((c.size === 'w' ? 'Width' : 'Length') + ' (' + U() + ')', num(toU(o.w || 0), 1, 3000, (v) => { const f = fromU(v); if (f) o.w = f; }, { 'aria-label': c.label + ' length' })));
      if (c.size === 'wh') ctl.append(field('Depth (' + U() + ')', num(toU(o.h || 0), 1, 3000, (v) => { const f = fromU(v); if (f) o.h = f; }, { 'aria-label': c.label + ' depth' })));
      row.append(ctl); list.append(row);
    });
    p.append(list);
    const cp = el('label', 'lw-carpet'); const cc = el('input', null, null, { type: 'checkbox', id: 'wizCarpet' }); cc.checked = !!spec.carpet;
    cc.addEventListener('change', () => { spec.carpet = cc.checked; });
    cp.append(cc, el('span', null, 'Aisle carpet — runs only from the entrance up the centre aisle to the front (off by default)'));
    p.append(cp);
  }
  function stepReview(p) {
    const pl = seatPlan(spec), s = spec.seating;
    const dl = el('dl', 'lw-sum');
    const add = (k, v) => { dl.append(el('dt', null, k), el('dd', null, v)); };
    add('Event', TYPES[spec.type].label);
    add('Hall', `${toU(spec.hall.w)} × ${toU(spec.hall.h)} ${U()}`);
    add('Guests', spec.guests ? spec.guests.toLocaleString('en-IN') : '—');
    add('Seating', SEATING_STYLES[s.style] + (s.style === 'rounds' ? ` · ${s.tables} × ${s.spt}` : s.style === 'theatre' ? ' · ' + theatreText(s, pl.main) : s.style === 'banquet' ? ` · ${s.longTables} × ${s.perLong}` : s.style === 'mixed' ? ` · ${s.mixRounds} rounds + ` + theatreText(s, Math.max(0, pl.main - Math.min(pl.main, s.mixRounds * s.spt))) : ''));
    add('Seats', `${pl.total} (${pl.main} main + ${pl.extras} VIP/stage)`);
    add('Objects', Object.entries(spec.objects).filter(([, o]) => o.on).map(([k, o]) => OBJECTS[k].label + (OBJECTS[k].multi && o.qty > 1 ? ' ×' + o.qty : '')).join(', '));
    add('Aisle carpet', spec.carpet ? 'Yes (entrance → front)' : 'No');
    p.append(dl);
    if (!pl.match) p.append(el('p', 'lw-warn', `Seats (${pl.total}) don't match the target (${pl.target}). Go back to Seating and press “Match seats to target”, or generate anyway.`));
    const res = el('div', 'lw-result', null, { id: 'wizResult', 'aria-live': 'polite' });
    p.append(res);
  }
  function preview(items, W, H) {
    const NS = 'http://www.w3.org/2000/svg', svg = doc.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('class', 'lw-prev'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', 'Preview of the generated layout');
    const r = doc.createElementNS(NS, 'rect'); ['x', 'y'].forEach((k) => r.setAttribute(k, '0')); r.setAttribute('width', W); r.setAttribute('height', H); r.setAttribute('class', 'lw-p-hall'); svg.append(r);
    items.forEach((it) => { const q = (((+it.rotation || 0) % 180) + 180) % 180, sw = q > 45 && q < 135 ? it.height : it.width, sh = q > 45 && q < 135 ? it.width : it.height;
      const e = doc.createElementNS(NS, it.type === 'table' ? 'circle' : 'rect');
      if (it.type === 'table') { e.setAttribute('cx', it.x + it.width / 2); e.setAttribute('cy', it.y + it.height / 2); e.setAttribute('r', it.width / 2); }
      else { e.setAttribute('x', it.x + it.width / 2 - sw / 2); e.setAttribute('y', it.y + it.height / 2 - sh / 2); e.setAttribute('width', sw); e.setAttribute('height', sh); }
      e.setAttribute('class', 'lw-p-' + (it.category || 'structure')); svg.append(e); });
    return svg;
  }
  function deps() { return { ASSETS: g('ASSETS'), makeItem: g('makeItem'), genSeats: g('genSeats') }; }
  function generate() {
    const W = Math.round(spec.hall.w), H = Math.round(spec.hall.h);
    const out = layout(spec, deps()); lastResult = out; remember();
    const res = doc.getElementById('wizResult'); if (!res) return;
    res.replaceChildren();
    const head2 = el('div', 'lw-rhead');
    head2.append(el('b', null, out.fits ? '✓ Everything fits' : '⚠ Hall is tight'), el('span', null, ` · ${out.seats} seats · ${out.items.length} objects`));
    res.append(head2, preview(out.items, W, H));
    out.warnings.forEach((w) => res.append(el('p', 'lw-warn', w)));
  }
  function apply(out) {
    const WORLD = g('WORLD'), store = g('store');
    try {
      WORLD.w = Math.round(spec.hall.w); WORLD.h = Math.round(spec.hall.h);
      store.venue = store.venue || {}; store.venue.room = { w: WORLD.w, h: WORLD.h };
      const call = (n, ...a) => { const f = g(n); if (typeof f === 'function') return f(...a); };
      call('updateDimsLabel'); call('sizeCanvas');
      call('loadItems', out.items.map((i) => Object.assign({}, i)), 'Layout · ' + TYPES[spec.type].label);
      const PR = g('PRICING');
      if (spec.guests && PR) { PR.guests = spec.guests; const gi = doc.getElementById('bGuests'); if (gi) gi.value = spec.guests; }
      const patch = { hallLen: WORLD.w, hallWid: WORLD.h };
      if (spec.guests) patch.guests = spec.guests;
      if (out.seats) { patch.chairs = out.seats; patch.chairsManual = !!spec._chairsManual; }
      const ps = call('persistSizing', patch);
      Promise.resolve(ps).then(() => { if (spec.guests) call('persistGuests'); }).catch(() => {});
      close(); call('renderAll'); call('fitView'); call('renderPrice');
      call('toast', `${TYPES[spec.type].label} layout · ${out.seats} seats, ${out.items.length} objects`);
    } catch (e) { try { G.BPUI && G.BPUI.toast('Could not place the layout', { type: 'err' }); } catch (_) {} }
  }
  // B9: the Review step draws its preview on open; ONE primary action ("Place on floor") below
  function go(i) { step = clamp(i, 0, 3); renderBody(); if (step === 3) generate(); const f = body.querySelector('input,select,button'); if (f) try { f.focus({ preventScroll: true }); } catch (_) {} }
  function prefillSpec() {
    const saved = recall(); if (saved) return saved;
    const PR = g('PRICING') || {}, cl = g('currentClient') || {}, W = g('WORLD') || { w: 200, h: 140 };
    const room = (g('store') && g('store').venue && g('store').venue.room) || W;
    const guests = posInt(PR.guests) || posInt(cl.guests);
    let chairs = 0; try { const qc = g('quoteChairsNow'); if (g('currentQuoteId') && typeof qc === 'function') chairs = posInt(qc()); } catch (_) {}
    const cc = studioCountry();
    const s = defaults(PR.eventType || cl.eventType || (cc === 'AE' ? 'galadinner' : 'wedding'), { country: cc, guests, chairs, w: posInt(cl.hallLen) || room.w, h: posInt(cl.hallWid) || room.h });
    s._chairsManual = !!(cl.chairsManual);
    return s;
  }
  function open(e) {
    opener = (e && e.currentTarget) || doc.activeElement;
    spec = prefillSpec(); step = 0; modal.hidden = false; renderBody();
    bMine.hidden = !(G.HelmStudioTemplates && G.HelmStudioTemplates.hasAny());
    const f = modal.querySelector('#wizType'); if (f) f.focus();
  }
  function close() { modal.hidden = true; if (opener && opener.focus) try { opener.focus(); } catch (_) {} }
  bClose.addEventListener('click', close);
  bBack.addEventListener('click', () => go(step - 1));
  bNext.addEventListener('click', () => { if (step < 3) { remember(); go(step + 1); } else { generate(); if (lastResult) apply(lastResult); } });
  bMine.addEventListener('click', () => { close(); if (G.HelmStudioTemplates) G.HelmStudioTemplates.openPicker(); });
  bClassic.addEventListener('click', () => { close(); const f = g('openCustomModal'); if (typeof f === 'function') f(); });
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  modal.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.key === 'Tab') {   // focus trap
      const f = [...modal.querySelectorAll('button:not([disabled]),input:not([disabled]),select,[tabindex="0"]')].filter((x) => x.offsetParent !== null);
      if (!f.length) return; const a = f[0], z = f[f.length - 1];
      if (e.shiftKey && doc.activeElement === a) { e.preventDefault(); z.focus(); } else if (!e.shiftKey && doc.activeElement === z) { e.preventDefault(); a.focus(); }
    }
  });
  function mount() {
    doc.body.append(modal);
    // the Custom Event / Create layout entry points open the wizard (capture: before builder.js's own handler)
    ['customBtn', 'es_custom'].forEach((id) => { const b = doc.getElementById(id); if (!b) return;
      b.addEventListener('click', (e) => { e.stopImmediatePropagation(); open(e); }, true);
      if (id === 'customBtn') { if (!b.querySelector('.tl')) b.textContent = '✨ Create layout'; b.title = 'Create a layout from your requirements: hall, guests, seating and objects'; } });
  }
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', mount); else mount();
  API._ui = { open, close, generate, apply, get spec() { return spec; }, set spec(v) { spec = v; }, get result() { return lastResult; }, go };
})(typeof window !== 'undefined' ? window : globalThis);
