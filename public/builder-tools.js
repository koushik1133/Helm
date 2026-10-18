/* builder-tools.js — pure helpers for the builder's tools + the product search bar.
 *
 *   HelmBuilderTools.snapTo(v, cell, on)          → snapped coordinate (ft); off → 0.1 ft rounding
 *   HelmBuilderTools.gridAlign(W, H, cell)        → { size, divisions, offX, offZ } for the 3D GridHelper so
 *                                                    its lines sit EXACTLY on the 2D grid (hall origin = top-left)
 *   HelmBuilderTools.offsets(box, world)          → X/Y offsets of an object from the origin, every wall and
 *                                                    the hall's centre axes (measure tool)
 *   HelmBuilderTools.searchAssets(q, assets, cats, opts) → ranked fuzzy matches (name / category / tags)
 *   HelmBuilderTools.eventSuggestions(eventType, assets)  → asset types that suit the event type
 *   HelmBuilderTools.normPriceDisplay(x)          → { hidden, manualAmount } (hide-price mode, sanitised)
 *
 * The search UI (mountSearch) wires #assetSearch / #assetSuggest in builder.html; it reads the catalogue
 * from builder.js's ASSETS / CATS globals and adds through the toolbox's own .tool buttons (same path as a click).
 * No HTML-string sinks: every node is created with createElement + textContent (CSP / Trusted Types).
 */
(function (G) {
  'use strict';

  /* ---------------- snap / grid ---------------- */
  // Snap a feet value to the grid cell. Snapped values keep 4 decimals so a metre grid (3.28084 ft) is not
  // pushed off its lines by 0.1-ft rounding (the old round1 put a 1 m cell at 3.3 ft, 3 m at 9.8 ft...).
  function snapTo(v, cell, on) {
    v = +v; if (!isFinite(v)) return 0;
    if (!on || !(cell > 0)) return Math.round(v * 10) / 10;
    return Math.round(Math.round(v / cell) * cell * 1e4) / 1e4;
  }
  // three.js GridHelper(size, divisions) is centred on the origin with lines at -size/2 + k*step. The 3D scene is
  // centred on the hall, so the hall's top-left is at (-W/2, -H/2). Lines line up with the 2D grid only when
  // (offset - size/2) ≡ -W/2 (mod cell): pick an even number of cells and shift by the remainder.
  function gridAlign(W, H, cell) {
    cell = cell > 0 ? cell : 1;
    const span = Math.max(+W || 0, +H || 0) + 40;
    let half = Math.ceil(span / (2 * cell));
    if (half * 2 > 1200) half = 600;                       // GridHelper line budget
    const divisions = half * 2, size = divisions * cell;
    const fx = (x) => { const o = cell * Math.round((x / 2) / cell) - x / 2; return Math.abs(o) < 1e-9 ? 0 : o; };
    return { size, divisions, offX: fx(+W || 0), offZ: fx(+H || 0) };
  }

  /* ---------------- measure ---------------- */
  function offsets(b, world) {
    const W = +world.w || 0, H = +world.h || 0, r1 = (v) => Math.round(v * 100) / 100;
    const l = +b.x, t = +b.y, r = l + (+b.width), btm = t + (+b.height), cx = (l + r) / 2, cy = (t + btm) / 2;
    const left = r1(l), right = r1(W - r), top = r1(t), bottom = r1(H - btm);
    return {
      left, right, top, bottom,                                     // clearance to each wall edge
      x: r1(l), y: r1(t),                                           // offset from the origin (top-left corner)
      cx: r1(cx), cy: r1(cy),
      fromCentreX: r1(cx - W / 2), fromCentreY: r1(cy - H / 2),     // offset from the hall's centre axes
      nearestX: left <= right ? { side: 'left', gap: left } : { side: 'right', gap: right },
      nearestY: top <= bottom ? { side: 'top', gap: top } : { side: 'bottom', gap: bottom },
    };
  }

  /* ---------------- product search ---------------- */
  // extra words people type for each product (synonyms / what it is used for)
  const TAGS = {
    stage: 'platform riser main performance', dancefloor: 'dance floor party', podium: 'lectern speech mic',
    press: 'media camera riser', dj: 'music console', chairrow: 'chairs seats row theatre', seatblock: 'chairs seats theatre audience block',
    table: 'round banquet dining seats', barricade: 'crowd control security', fence: 'perimeter boundary', booth: 'expo stall exhibitor',
    desk: 'registration reception check-in counter', truck: 'food vendor', exit: 'emergency door entrance gate', canopy: 'shade cover',
    arch: 'backdrop entrance photo', tent: 'marquee shamiana', longtable: 'banquet rectangular dining', headtable: 'top table bride groom vip',
    cocktail: 'highboy poseur standing', lounge: 'sofa seating vip', photobooth: 'photo selfie camera', checkpoint: 'security scan entry',
    bar: 'drinks beverage counter', buffet: 'food catering counter', gifttable: 'gifts presents', caketable: 'cake dessert',
    restroom: 'toilet washroom bathroom', ledscreen: 'screen display projector video', truss: 'lighting rig tower', speaker: 'sound audio pa',
    coatcheck: 'cloakroom', firstaid: 'medical emergency', planter: 'plants greenery flowers', redcarpet: 'aisle carpet walkway',
    parking: 'cars vehicles', sofa: 'couch lounge', loveseat: 'couch two seater', armchair: 'chair lounge', ottoman: 'pouf stool',
    bench: 'seat', coffeetable: 'side table', floral: 'flowers centrepiece centerpiece', floralarch: 'flowers arch backdrop',
    mandap: 'wedding canopy ceremony', pillar: 'column decor', drape: 'curtain backdrop', chandelier: 'lighting crystal',
    fountain: 'water decor', uplight: 'lighting led wash', heater: 'outdoor warmth', easel: 'sign welcome board',
    chiavari: 'chair wedding chiavari ghost crossback folding banquet plastic single seat generic', barstool: 'stool chair', piano: 'music grand',
    // complete-catalogue pass (2026-10d): what planners actually type
    uplight: 'uplight uplighter uplighting par can wash light generic light', lighting: 'truss lights rig par moving overhead',
    lightingtree: 'light stand t-bar tripod par', movinghead: 'moving head beam sharpy spot', ledscreen: 'screen display tv projector video',
    led: 'screen display video wall p3 backdrop', videowall: 'screen imag big screen', linearray: 'speaker sound pa line array',
    subwoofer: 'bass speaker sub', monitor: 'wedge foldback speaker', foh: 'sound desk mixer console front of house', patower: 'speaker tower sound pa',
    truss: 'truss tower goal post rig', canopy: 'canopy gazebo shade pergola chuppah', tent: 'marquee shamiana pandal hangar',
    drape: 'pipe and drape curtain backdrop fabric', redcarpet: 'aisle runner carpet red carpet walkway', walkway: 'ramp catwalk runway',
    jhoola: 'swing jhoola jhula seat', entrancegate: 'entrance gate welcome gate dwar', floralentrance: 'entrance arch flower gateway',
    mandap: 'mandap mandapam wedding canopy pheras ceremony', stagebackdrop: 'stage backdrop floral wall behind couple', welcomeboard: 'welcome sign board easel',
    neonsign: 'neon sign light text glow', photobooth: 'photo booth selfie camera 360 booth', selfieframe: 'selfie frame photo frame',
    cocktail: 'cocktail table highboy poseur standing bar table', bar: 'bar drinks mocktail beverage counter champagne', buffet: 'buffet food catering counter',
    livecounter: 'live counter chaat dosa food station', brandwall: 'branding wall step and repeat media wall logo backdrop',
    hoarding: 'hoarding banner flex billboard', flagstand: 'flag pole stand', lectern: 'lectern podium speech dais mic', dais: 'dais vip platform',
    barricade: 'barricade crowd control barrier', stagebarrier: 'stage barrier front of stage pit barricade', fence: 'fence perimeter boundary',
    checkpoint: 'security check metal detector dfmd frisking', exit: 'exit entrance emergency door', firstaid: 'first aid medical',
    diyastand: 'diya lamp deepam samai vilakku', havankund: 'havan kund homam yagna fire pooja', rangoli: 'rangoli kolam muggu floor art',
    toran: 'toran bandhanwar garland door', phoolchadar: 'phoolon ki chadar flower canopy', haldi: 'haldi pithi yellow', mehendi: 'mehendi mehndi henna lounge',
    balloonarch: 'balloon arch garland', balloonbunch: 'balloon bouquet bunch helium', kidszone: 'kids play bouncy castle ball pit slide',
    couplesofa: 'couple sofa maharaja throne', fairylights: 'fairy lights string lights canopy', chandelier: 'chandelier crystal jhoomar',
    lanterns: 'lantern candles moroccan', hangingfloral: 'hanging flowers ceiling floral installation', flowerwall: 'flower wall photo wall',
    aircooler: 'cooler fan mist', generator: 'generator genset dg power', distro: 'power distribution board', greenroom: 'green room backstage artist',
    trophytable: 'trophy awards display', chocolatefountain: 'chocolate fountain dessert', chariot: 'chariot baggi carriage doli entry',
    dancers: 'dancers performers troupe', smoke: 'fog haze smoke machine', booth: 'expo booth stall shell scheme exhibitor',
  };
  // event-type families → the products planners usually reach for first
  const EVENT_SETS = [
    [/wedding|marriage|reception|engagement|sangeet|mehndi/i, ['mandap', 'floralarch', 'headtable', 'table', 'dancefloor', 'caketable', 'chiavari', 'buffet']],
    [/birthday|party|private|anniversary/i, ['caketable', 'dancefloor', 'dj', 'photobooth', 'bar', 'table', 'lounge']],
    [/gala|award|banquet|dinner/i, ['stage', 'table', 'chandelier', 'bar', 'ledscreen', 'podium', 'dancefloor']],
    [/conference|seminar|corporate|launch|expo|classroom|townhall|town hall/i, ['stage', 'podium', 'seatblock', 'ledscreen', 'desk', 'booth', 'coffeetable']],
    [/concert|festival|music|club|stadium|sport/i, ['stage', 'speaker', 'truss', 'barricade', 'truck', 'restroom', 'firstaid']],
    [/political|rally/i, ['stage', 'podium', 'barricade', 'seatblock', 'checkpoint', 'speaker', 'press']],
  ];
  const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  // 0 = no match. Prefix of the whole text > prefix of a word > substring > in-order letters (typo-tolerant-ish).
  function fuzzyScore(q, text) {
    q = norm(q); text = norm(text); if (!q || !text) return 0;
    if (text === q) return 120;
    if (text.startsWith(q)) return 100 - Math.min(20, text.length - q.length);
    const words = text.split(' ');
    if (words.some((w) => w.startsWith(q))) return 80;
    const i = text.indexOf(q); if (i >= 0) return 60 - Math.min(15, i);
    // every query word must hit some word prefix (multi-word queries: "round tab")
    const qw = q.split(' '); if (qw.length > 1 && qw.every((x) => words.some((w) => w.startsWith(x)))) return 70;
    // subsequence: all letters in order; fewer gaps score higher
    let ti = 0, gaps = 0, last = -1;
    const qs = q.replace(/ /g, '');
    for (const ch of qs) { const k = text.indexOf(ch, ti); if (k < 0) return 0; if (last >= 0) gaps += k - last - 1; last = k; ti = k + 1; }
    if (qs.length < 3) return 0;
    return Math.max(1, 35 - gaps * 2);
  }
  function searchAssets(q, assets, cats, opts) {
    const limit = (opts && opts.limit) || 8, out = [];
    Object.keys(assets || {}).forEach((type) => {
      const a = assets[type] || {}, catName = (cats && cats[a.category] && cats[a.category].name) || a.category || '';
      const tags = (TAGS[type] || '') + ' ' + (typeof a.tags === 'string' ? a.tags : ''), sec = typeof a.section === 'string' ? a.section : '';
      const s = Math.max(fuzzyScore(q, a.label) * 1.0, fuzzyScore(q, type) * 0.9, fuzzyScore(q, catName) * 0.6, fuzzyScore(q, sec) * 0.6, fuzzyScore(q, tags) * 0.75);
      if (s > 0) out.push({ type, label: a.label || type, category: a.category || '', categoryName: catName, score: Math.round(s * 10) / 10 });
    });
    out.sort((x, y) => y.score - x.score || x.label.localeCompare(y.label));
    return out.slice(0, limit);
  }
  function eventSuggestions(eventType, assets) {
    const t = String(eventType || ''); if (!t) return [];
    const hit = EVENT_SETS.find(([re]) => re.test(t.replace(/_/g, ' ')));
    return hit ? hit[1].filter((k) => !assets || assets[k]) : [];
  }

  /* ---------------- hide-price mode ---------------- */
  function normPriceDisplay(x) {
    const o = x && typeof x === 'object' ? x : {};
    const n = o.manualAmount == null || o.manualAmount === '' ? null : Number(o.manualAmount);
    return { hidden: o.hidden === true, manualAmount: n != null && isFinite(n) && n >= 0 ? Math.min(Math.round(n * 100) / 100, 1e12) : null };
  }

  /* ---------------- 2D draw order (r19) ---------------- */
  // The 3D view lays floor coverings (carpet, aisle runner, dance floor, walkway, parking, any piece that
  // covers most of the hall) flat on the floor UNDER everything else. The 2D plan drew strictly in array
  // order, so a full-hall "Carpet / Aisle" added after the stage hid the stage, screens, truss and pillars.
  // drawOrder keeps the saved order for everything else and only lifts floor coverings to the bottom:
  // the biggest covering first, so a dance floor laid on a full carpet still shows. Pure; never mutates.
  const FLOOR_TYPES = { redcarpet: 1, dancefloor: 1, walkway: 1, parking: 1, carpet: 1, rug: 1, flooring: 1, grass: 1, lawn: 1, floor: 1 };
  function footprint(it) {
    const w = Math.abs(+it.width) || 0, h = Math.abs(+it.height) || 0;
    return isFinite(w * h) ? w * h : 0;
  }
  function isFloorCover(it, world) {
    if (!it || typeof it !== 'object') return false;
    if (FLOOR_TYPES[String(it.type || '').toLowerCase()]) return true;
    const W = world && +world.w, H = world && +world.h;
    return W > 0 && H > 0 && footprint(it) >= 0.5 * W * H;   // anything spread over half the hall or more
  }
  function drawOrder(items, world) {
    const list = Array.isArray(items) ? items : [];
    const floor = [], rest = [];
    list.forEach((it, i) => { (isFloorCover(it, world) ? floor : rest).push({ it, i }); });
    if (!floor.length) return list.slice();
    floor.sort((a, b) => (footprint(b.it) - footprint(a.it)) || (a.i - b.i));
    return floor.map((x) => x.it).concat(rest.map((x) => x.it));
  }

  const API = { snapTo, gridAlign, offsets, fuzzyScore, searchAssets, eventSuggestions, normPriceDisplay, isFloorCover, drawOrder, TAGS };
  G.HelmBuilderTools = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (!G.document) return;

  /* ---------------- search bar UI ---------------- */
  const doc = G.document, RECENT_KEY = 'helm.builder.recentAssets';
  const readRecent = () => { try { const a = JSON.parse(G.localStorage.getItem(RECENT_KEY) || '[]'); return Array.isArray(a) ? a.filter((x) => typeof x === 'string').slice(0, 6) : []; } catch (_) { return []; } };
  const pushRecent = (t) => { try { const a = [t].concat(readRecent().filter((x) => x !== t)).slice(0, 6); G.localStorage.setItem(RECENT_KEY, JSON.stringify(a)); } catch (_) {} };
  const catalogue = () => { try { return { assets: ASSETS, cats: typeof CATS !== 'undefined' ? CATS : {} }; } catch (_) { return { assets: {}, cats: {} }; } };  // eslint-disable-line no-undef
  const eventType = () => { try { return (typeof PRICING !== 'undefined' && PRICING.eventType) || (doc.getElementById('preset') || {}).value || ''; } catch (_) { return ''; } };  // eslint-disable-line no-undef

  function mountSearch() {
    const input = doc.getElementById('assetSearch'), list = doc.getElementById('assetSuggest');
    if (!input || !list || input.dataset.wired) return; input.dataset.wired = '1';
    let rows = [], active = -1;
    const mk = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
    function options() {
      const { assets, cats } = catalogue(), q = input.value.trim();
      if (q) return { groups: [['Products', searchAssets(q, assets, cats, { limit: 8 })]], q };
      const rec = readRecent().filter((t) => assets[t]).map((t) => ({ type: t, label: assets[t].label, categoryName: (cats[assets[t].category] || {}).name || '' }));
      const ev = eventSuggestions(eventType(), assets).filter((t) => !rec.some((r) => r.type === t)).slice(0, 6)
        .map((t) => ({ type: t, label: assets[t].label, categoryName: (cats[assets[t].category] || {}).name || '' }));
      return { groups: [['Recent', rec], ['Suggested for this event', ev]], q };
    }
    function filterToolbox(q) {
      const host = doc.getElementById('toolbox'); if (!host) return;
      const { assets, cats } = catalogue();
      const hits = q ? new Set(searchAssets(q, assets, cats, { limit: 999 }).map((r) => r.type)) : null;
      host.querySelectorAll('.tool').forEach((t) => t.classList.toggle('ts-miss', !!hits && !hits.has(t.dataset.type)));
      host.querySelectorAll('.cat').forEach((c) => c.classList.toggle('ts-empty', !!hits && !c.querySelector('.tool:not(.ts-miss)')));
    }
    function render() {
      const { groups, q } = options();
      while (list.firstChild) list.removeChild(list.firstChild);
      rows = []; active = -1;
      groups.forEach(([title, items]) => {
        if (!items.length) return;
        const h = mk('li', 'ts-head', title); h.setAttribute('role', 'presentation'); list.append(h);
        items.forEach((r) => {
          const li = mk('li', 'ts-opt'); li.id = 'ts-opt-' + rows.length; li.setAttribute('role', 'option'); li.setAttribute('aria-selected', 'false');
          li.dataset.type = r.type;
          li.append(mk('span', 'ts-name', r.label), mk('span', 'ts-cat', r.categoryName || ''));
          li.addEventListener('mousedown', (e) => { e.preventDefault(); choose(r.type); });
          list.append(li); rows.push(li);
        });
      });
      if (q && !rows.length) { const e = mk('li', 'ts-none', 'No products match “' + q + '”'); e.setAttribute('role', 'presentation'); list.append(e); }
      const open = doc.activeElement === input && list.childNodes.length > 0;
      list.hidden = !open; input.setAttribute('aria-expanded', String(open)); input.removeAttribute('aria-activedescendant');
    }
    function move(d) {
      if (!rows.length) return; active = (active + d + rows.length) % rows.length;
      rows.forEach((r, i) => { r.classList.toggle('on', i === active); r.setAttribute('aria-selected', String(i === active)); });
      input.setAttribute('aria-activedescendant', rows[active].id);
      try { rows[active].scrollIntoView({ block: 'nearest' }); } catch (_) {}
    }
    function close() { list.hidden = true; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); }
    function choose(type) {
      const tool = doc.querySelector('#toolbox .tool[data-type="' + String(type).replace(/[^a-z0-9_-]/gi, '') + '"]:not([data-label])')
        || doc.querySelector('#toolbox .tool[data-type="' + String(type).replace(/[^a-z0-9_-]/gi, '') + '"]');
      if (!tool || tool.getAttribute('aria-disabled') === 'true') return;
      pushRecent(type); input.value = ''; filterToolbox(''); close(); input.blur();
      tool.click();                                           // same path as clicking the toolbox tile
    }
    input.addEventListener('input', () => { filterToolbox(input.value.trim()); render(); });
    input.addEventListener('focus', render);
    input.addEventListener('blur', () => setTimeout(close, 120));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); if (list.hidden) render(); move(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
      else if (e.key === 'Enter') { e.preventDefault(); const r = rows[active >= 0 ? active : 0]; if (r) choose(r.dataset.type); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (input.value) { input.value = ''; filterToolbox(''); render(); } else { close(); input.blur(); } }
    });
    // "/" focuses the search (never while typing in another field)
    // capture phase on window + stopImmediatePropagation: the app-wide command palette (studio-search.js) also
    // binds "/" on document — in the builder the toolbox hint promises "/" = product search, so it wins here
    const win = doc.defaultView || G;
    win.addEventListener('keydown', (e) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target || {}; if (/INPUT|SELECT|TEXTAREA/.test(t.tagName || '') || t.isContentEditable) return;
      if (doc.querySelector('.modal:not([hidden]), .bpui-overlay, dialog[open]')) return;
      if (!input.isConnected || !input.offsetParent) return;   // toolbox hidden (e.g. phone drawer closed): leave "/" to the palette
      e.preventDefault(); e.stopImmediatePropagation(); input.focus();
    }, true);
  }
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', mountSearch); else mountSearch();
  API._mountSearch = mountSearch;
})(typeof window !== 'undefined' ? window : globalThis);
