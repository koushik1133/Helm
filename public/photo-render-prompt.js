/* photo-render-prompt.js - HelmPhotoPrompt: turns a builder layout into a detailed, layout-exact
   prompt for the server-side photo render (edge function render-photo, migration 0095).
   PURE: no DOM, no network. Works in the browser (window.HelmPhotoPrompt) and in Node tests.

   build({ items, world:{w,h}, eventType, guests, setting, evening, style, camera, theme, country })
     -> { style, camera, system, layout, prompt, stats }
   Prompt structure (render fidelity, follows OpenAI's GPT-image prompting guide: labelled segments,
   scene first, each input image labelled by index + role, preserve-list repeated):
     1. ENVIRONMENT block FIRST - strong, style-specific (outdoor open sky vs indoor ballroom), never
        overridden by the venue setting; a one-line environment reminder is repeated at the very end
     2. image roles (Image 1 camera, 2 plan, 3 labelled plan for scale, 4 colour-coded semantic map)
     3. hard rules (same layout / counts / positions, no text / labels / measurement lines)
     4. INVENTORY: same-type objects clustered into groups by proximity + rows/columns, each group with
        exact count, arrangement ("2 rows x 8 sofas = 16"), position relative to stage / aisle / other groups
     5. COUNT CHECKLIST + explicit "verify every count before finalising"
   semanticMap(items, world) -> flat colour shapes + legend for reference image 4 (drawn by photo-render-ui.js). */
(function (root) {
  'use strict';

  var STYLES = {
    golden:   { label: 'Golden hour outdoor', light: 'warm golden-hour sunlight about 40 minutes before sunset, low sun raking from one side, long soft shadows, glowing rim light on florals and chairs, clear sky with a soft warm gradient', setting: 'outdoor' },
    evening:  { label: 'Evening lights',     light: 'blue-hour dusk just after sunset, deep blue sky, the event lit by warm festoon string lights, uplighters, candles and stage lighting, LED screens glowing, practical light pools on the ground, gentle haze', setting: null },
    daylight: { label: 'Daylight',           light: 'bright natural midday daylight, soft high clouds, true-to-life colours, gentle shadows directly under objects', setting: 'outdoor' },
    ballroom: { label: 'Indoor ballroom',    light: 'an elegant indoor ballroom: warm ambient light from chandeliers and ceiling coves, soft pin-spots on tables and florals, warm uplighting on walls and drapes, polished floor reflections', setting: 'indoor' },
  };
  /* ENVIRONMENT blocks: the first thing in the prompt; the outdoor ones never mention interior
     architecture (an interior word makes the model drift to a ballroom). */
  var ENV = {
    golden: {
      outdoor: 'ENVIRONMENT (mandatory, overrides anything the reference images suggest): an OPEN-AIR outdoor event on a manicured green lawn and pale stone terrace, completely open to the sky. Golden hour about 40 minutes before sunset: the sun is LOW near the horizon, warm amber-orange light rakes across the scene from one side, every chair, sofa and floral stand casts a LONG shadow across the grass, glowing rim light on florals, a warm gradient sky with a few soft clouds. Mature trees, hedges and flower beds frame the venue edges; open landscape beyond. Nothing overhead but sky.',
      remind: 'Reminder: open-air lawn at golden hour - low warm sun, long shadows, open sky, trees around the edges.',
    },
    evening: {
      outdoor: 'ENVIRONMENT (mandatory, overrides anything the reference images suggest): an OPEN-AIR outdoor event at blue hour / early night: deep blue-to-indigo sky with the last glow on the horizon, a few stars. The venue glows with warm festoon string lights and fairy lights strung overhead, amber uplights washing the trees and florals, candles on tables, LED screens and the stage lit brightly, pools of warm light on the lawn and dark landscaping beyond. Strong contrast between the warm-lit event and the cool dark sky.',
      indoor: 'ENVIRONMENT (mandatory): an INDOOR ballroom in the evening with the house lights dimmed: crystal chandeliers glowing softly overhead, warm amber uplights washing the walls and drapes, candlelight on the tables, the stage and LED screens lit brightly as the focal point, a moody low-key atmosphere with deep shadows between light pools.',
      remind: 'Reminder: evening - dark sky or dimmed room, warm festoon/fairy lights and uplights glowing.',
      remindIndoor: 'Reminder: dimmed indoor ballroom in the evening - glowing chandeliers, warm uplights, candlelight.',
    },
    daylight: {
      outdoor: 'ENVIRONMENT (mandatory, overrides anything the reference images suggest): an OPEN-AIR outdoor event at bright midday on a manicured green lawn, completely open to the sky. High sun, crisp neutral white balance, true-to-life colours, short sharp shadows directly under objects, clear blue sky with light high clouds, vivid green grass, trees and hedges around the venue edges.',
      remind: 'Reminder: open-air lawn in bright midday sun - blue sky, short shadows, neutral colours.',
    },
    ballroom: {
      indoor: 'ENVIRONMENT (mandatory): a grand INDOOR ballroom: high ceiling with ornate coffers and several large crystal chandeliers, walls dressed with soft ivory drapes and warm uplighting, a patterned luxury carpet / polished floor, warm ambient light, soft pin-spots on tables and florals. No sky and no outdoor landscaping visible.',
      remind: 'Reminder: indoor ballroom - ceiling with chandeliers, draped walls, carpeted floor.',
    },
  };
  // the environment actually rendered: the chosen style wins over the venue setting
  function envFor(style, setting) {
    var st = STYLES[style] || STYLES.golden;
    var where = st.setting || (setting === 'indoor' ? 'indoor' : 'outdoor');
    var e = ENV[style] || ENV.golden;
    return { where: where, text: e[where] || e.outdoor || e.indoor, remind: where === 'indoor' && e.remindIndoor ? e.remindIndoor : e.remind };
  }
  var CAMERAS = {
    hero: { label: 'Hero aerial', text: 'High aerial three-quarter drone photograph taken from EXACTLY the same position, height and angle as reference image 1 (the 3D overview) - same framing, same perspective, same side of the venue in the foreground. Shot on a full-frame camera with a 24mm lens at f/8, everything in sharp focus.' },
    top:  { label: 'Top-down',    text: 'Straight-down aerial drone photograph (nadir view, camera pointing directly at the ground) covering the whole venue, oriented exactly like reference image 2 (same edge at the top). 24mm lens, f/8, everything in sharp focus.' },
    auto: { label: 'Best angle', text: null },
    current: { label: 'My 3D view', text: null },
    eye:  { label: 'Eye-level from entrance', text: 'Eye-level photograph from the guest entrance at the back of the venue, camera at 1.6 m height looking toward the stage along the main aisle, 35mm lens at f/5.6, natural perspective with the stage as the focal point.' },
  };
  CAMERAS.auto.text = CAMERAS.hero.text; CAMERAS.current.text = CAMERAS.hero.text;
  /* decor themes (dropdown). 'none' adds NO theme sentence - just realistic decor for the objects. */
  var THEMES = {
    none:      { label: 'None — just make it realistic', text: '' },
    royal:     { label: 'Royal Indian (gold & marigold)', text: 'royal Indian styling - rich gold and deep red accents, cascades of marigold and rose garlands, brass lamps and carved details' },
    pastel:    { label: 'Pastel floral (blush & ivory)', text: 'soft pastel florals - blush pink and ivory roses, peonies and hydrangeas, light sheer fabrics, airy and romantic' },
    whitegreen:{ label: 'Classic white & green', text: 'classic white and green - white roses and orchids with lush green foliage, crisp white linen, clean and timeless' },
    minimal:   { label: 'Modern minimal', text: 'modern minimal styling - clean lines, neutral palette, sculptural single-stem florals, matte finishes, uncluttered' },
    rustic:    { label: 'Rustic garden (fairy lights & wood)', text: 'rustic garden styling - natural wood, wildflowers and greenery, hanging fairy lights, lanterns and burlap accents' },
    arabian:   { label: 'Arabian luxury (gold & ivory, Dubai)', text: 'Arabian luxury styling as in Dubai - ivory and gold palette, ornate lanterns, mirrored and crystal accents, plush fabrics, white orchids' },
    bollywood: { label: 'Bollywood glam (bold colours & lights)', text: 'Bollywood glam - bold jewel colours (magenta, orange, emerald), sequins and drapes, dramatic coloured stage lights and sparkle' },
    corporate: { label: 'Corporate clean (brand blue & white)', text: 'clean corporate styling - crisp blue and white palette, modern furniture, neat signage frames without readable text, professional and tidy' },
    rally:     { label: 'Political rally (flags & podium)', text: 'political rally styling - rows of plain coloured flags and bunting (no readable text or symbols), the existing podium kept prominent, bright daylight-style stage lighting' },
    concert:   { label: 'Concert stage (lights & haze)', text: 'concert styling - dramatic coloured beams from moving lights, light haze in the air, LED walls glowing, high-energy stage atmosphere' },
  };
  /* "Highlight" focus areas: camera frames them closer + one prompt sentence */
  var FOCUS = {
    stage:    { label: 'Stage', types: ['stage', 'mandap', 'videowall', 'led', 'podium', 'headtable'], text: 'the stage area' },
    dance:    { label: 'Dance floor', types: ['dancefloor', 'dj'], text: 'the dance floor' },
    entrance: { label: 'Entrance', types: ['floralarch', 'arch', 'desk', 'checkpoint', 'redcarpet', 'walkway', 'easel', 'brandwall'], text: 'the entrance' },
    seating:  { label: 'Seating', types: ['seatblock', 'chairrow', 'table', 'longtable', 'chiavari', 'bleacher', 'sofa', 'lounge', 'cocktail'], text: 'the guest seating' },
  };
  var REGIONS = {
    IN: { name: 'India', text: 'Luxury Indian wedding decor finish on the existing objects: marigold, rose and jasmine in the existing florals, rich jewel-tone and ivory fabrics with gold accents.' },
    AE: { name: 'UAE', text: 'Dubai luxury event styling on the existing objects: white and champagne-gold palette, orchids and white roses in the existing florals, crystal and mirror accents, sleek modern finishes.' },
    US: { name: 'USA', text: 'Upscale American event styling on the existing objects: white hydrangeas, garden roses and greenery in the existing florals, natural wood and brushed brass accents, classic clean lines.' },
  };

  /* every ASSETS type in builder.js -> a photographic description (materials / colours) */
  var DESC = {
    stage: 'a raised event stage deck with a neatly skirted front and a finished top surface',
    dancefloor: 'a glossy black-and-white checkered dance floor laid flat on the ground',
    podium: 'a slim lectern podium in white and gold',
    press: 'a low black press riser platform for photographers and cameras',
    dj: 'a DJ booth with a glowing LED facade and decks on top',
    chairrow: 'a straight row of gold chiavari chairs with ivory cushions',
    seatblock: 'a theatre-style seating block of gold chiavari chairs with ivory cushions in neat straight rows',
    table: 'a round banquet table with a floor-length ivory tablecloth, gold charger plates, glassware and a floral centrepiece, surrounded by chiavari chairs',
    barricade: 'a line of polished chrome stanchions with plush red velvet ropes',
    fence: 'a neat perimeter fence line (white picket / decorative panel fence) along the venue edge',
    booth: 'a 3 m square expo booth with white shell-scheme walls and branded fascia (no readable text)',
    desk: 'a welcome / registration desk with an ivory skirted front and a small floral arrangement',
    truck: 'a stylish vintage-style food truck with warm lights and a serving hatch',
    exit: 'a clear exit pathway area kept free of furniture',
    canopy: 'a white fabric canopy / gazebo with sheer draped sides',
    arch: 'a decorative arch / backdrop frame dressed with fabric and florals',
    tent: 'a large white event tent (marquee) with peaked roof and sheer side drapes',
    longtable: 'a long rectangular banquet table with ivory linen, runner of florals and candles, chairs on both sides',
    headtable: 'a head table for the couple / VIPs with lush floral frontage and two ornate chairs at the centre',
    cocktail: 'a tall cocktail table with a fitted ivory spandex cover and a small posy',
    lounge: 'a lounge set of cream sofas and armchairs around a low coffee table on a rug',
    photobooth: 'a photo booth backdrop dressed as a floral wall',
    checkpoint: 'a security checkpoint walk-through frame',
    bar: 'an illuminated bar counter with a polished top and bottles on a back shelf',
    buffet: 'a buffet line of tables with ivory skirting and rows of polished silver chafing dishes, food warmers and small floral accents',
    gifttable: 'a gift table with ivory linen and a floral arrangement',
    caketable: 'a round cake table with a tall tiered white wedding cake on a stand and florals',
    restroom: 'portable luxury restroom kiosks / restroom trailer with clean white panels, discreetly placed',
    ledscreen: 'a freestanding LED video screen on a black stand, glowing',
    truss: 'a black aluminium lighting truss tower with lights',
    speaker: 'a black speaker stack on a stand',
    coatcheck: 'a coat-check counter with a rail of hangers',
    firstaid: 'a small first-aid tent / station with a discreet red cross marker',
    planter: 'lush potted greenery and topiary planters',
    redcarpet: 'a red carpet aisle runner laid flat on the ground',
    parking: 'a parking area with parked cars on asphalt or gravel',
    sofa: 'a cream / ivory tufted sofa with cushions',
    loveseat: 'a cream two-seat loveseat with cushions',
    armchair: 'an upholstered cream armchair',
    ottoman: 'a round upholstered ottoman pouf',
    bench: 'a wooden garden bench',
    coffeetable: 'a low coffee table with a small arrangement',
    floral: 'a tall floral centrepiece / floral stand of roses and hydrangeas',
    floralarch: 'a floral arch of roses, hydrangeas and greenery over the path',
    mandap: 'an ornate wedding mandap: four carved pillars, draped canopy in ivory and gold, heavy floral garlands, low seating for the ceremony',
    pillar: 'a decorative pillar column topped with florals',
    drape: 'pipe-and-drape panels of soft ivory fabric',
    chandelier: 'a crystal chandelier hanging above (in a tent / indoor) or on a decorative frame',
    fountain: 'a classic three-tier stone water fountain with flowing water',
    uplight: 'a small LED uplighter washing light upward',
    heater: 'a tall stainless-steel patio heater',
    easel: 'a signage easel holding a welcome board (blank or unreadable)',
    chiavari: 'a gold chiavari chair with an ivory cushion',
    barstool: 'a modern bar stool',
    piano: 'a glossy black grand piano',
    bleacher: 'tiered bleacher seating',
    linearray: 'a flown / ground-stacked line-array speaker hang',
    subwoofer: 'a black subwoofer cabinet',
    monitor: 'a wedge stage monitor',
    foh: 'a front-of-house sound and lighting console desk',
    movinghead: 'a moving-head stage light',
    videowall: 'a large LED video wall glowing with an abstract visual (no readable text)',
    generator: 'a silent power generator in an enclosure, tucked away discreetly',
    distro: 'a small power distribution box',
    cableramp: 'a low cable ramp protector on the ground',
    greenroom: 'a private green room tent / cabin',
    viprisers: 'a raised VIP riser platform with a carpeted top',
    stagebarrier: 'a black steel stage barrier line',
    lighting: 'an overhead lighting truss span with stage lights and warm wash fixtures',
    led: 'a large LED wall glowing with a soft floral / abstract visual (no readable text)',
    chocolatefountain: 'a tall chocolate fountain on a dressed table',
    chariot: 'an ornate decorated wedding chariot / carriage in white and gold with florals',
    smoke: 'a small low-fog machine (subtle haze, not visible as an object)',
    dancers: 'a group of performers in coordinated costumes',
    walkway: 'a raised carpeted walkway / ramp',
    brandwall: 'a decorative branding / welcome wall dressed with florals (no readable text)',
  };
  var NAMES = {
    stage: 'stage', dancefloor: 'dance floor', podium: 'podium', press: 'press riser', dj: 'DJ booth', chairrow: 'chair row',
    seatblock: 'seating block', table: 'round banquet table', barricade: 'stanchion line', fence: 'fence line', booth: 'expo booth',
    desk: 'welcome desk', truck: 'food truck', exit: 'exit pathway', canopy: 'canopy', arch: 'decor arch', tent: 'tent',
    longtable: 'banquet table', headtable: 'head table', cocktail: 'cocktail table', lounge: 'lounge set', photobooth: 'photo booth',
    checkpoint: 'security checkpoint', bar: 'bar', buffet: 'buffet line', gifttable: 'gift table', caketable: 'cake table',
    restroom: 'restroom kiosk', ledscreen: 'LED screen', truss: 'truss tower', speaker: 'speaker stack', coatcheck: 'coat check',
    firstaid: 'first-aid station', planter: 'greenery planter', redcarpet: 'red carpet aisle', parking: 'parking area', sofa: 'sofa',
    loveseat: 'loveseat', armchair: 'armchair', ottoman: 'ottoman', bench: 'bench', coffeetable: 'coffee table', floral: 'floral stand',
    floralarch: 'floral arch', mandap: 'mandap', pillar: 'decor pillar', drape: 'drape panel', chandelier: 'chandelier', fountain: 'fountain',
    uplight: 'uplighter', heater: 'patio heater', easel: 'signage easel', chiavari: 'chiavari chair', barstool: 'bar stool',
    piano: 'grand piano', bleacher: 'bleacher', linearray: 'line-array speaker', subwoofer: 'subwoofer', monitor: 'stage monitor',
    foh: 'FOH console', movinghead: 'moving light', videowall: 'LED video wall', generator: 'generator', distro: 'power distro',
    cableramp: 'cable ramp', greenroom: 'green room', viprisers: 'VIP riser', stagebarrier: 'stage barrier', lighting: 'lighting truss',
    led: 'LED wall', chocolatefountain: 'chocolate fountain', chariot: 'wedding chariot', smoke: 'fog machine', dancers: 'performer group',
    walkway: 'walkway', brandwall: 'branding wall',
  };
  // what "front" is measured from: the first of these found on the plan
  var FOCAL = ['stage', 'mandap', 'videowall', 'led', 'headtable', 'dj'];
  // never mentioned as objects (invisible in a photo)
  var SKIP = { exit: 1, smoke: 1, cableramp: 1, distro: 1 };

  function num(v, d) { v = Number(v); return isFinite(v) ? v : d; }
  function clean(s, max) { return String(s == null ? '' : s).replace(/[\u0000-\u001f<>{}`]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max || 120); }
  function ft(v) { v = Math.round(num(v, 0)); return v + ' ft (' + (Math.round(v * 0.3048 * 10) / 10) + ' m)'; }
  function plural(n, s) { if (n === 1) return s; if (/(sh|ch|s|x)$/.test(s)) return s + 'es'; if (/[^aeiou]y$/.test(s)) return s.slice(0, -1) + 'ies'; return s + 's'; }
  function seatsOf(it) {
    var p = it.properties || {};
    if (p.rows && p.cols) return num(p.rows, 0) * num(p.cols, 0);
    if (p.seats) return num(p.seats, 0);
    return it.type === 'chiavari' || it.type === 'barstool' ? 1 : 0;
  }
  function regionOf(country) {
    var c = String(country || '').toUpperCase();
    if (c === 'AE' || c === 'UAE') return 'AE';
    if (c === 'US' || c === 'USA') return 'US';
    return 'IN';
  }
  // objects that only exist at an outdoor venue: used when the venue setting is unknown
  var OUTDOOR_HINTS = { fountain: 1, parking: 1, truck: 1, generator: 1, tent: 1, fence: 1 };
  function inferSetting(setting, items) {
    if (setting === 'indoor' || setting === 'outdoor') return setting;
    return (items || []).some(function (it) { return it && OUTDOOR_HINTS[it.type]; }) ? 'outdoor' : 'indoor';
  }
  function defaultStyle(setting, evening, items) {
    if (evening) return 'evening';
    return inferSetting(setting, items) === 'indoor' ? 'ballroom' : 'golden';
  }

  // where the stage sits: which plan edge is "front"
  function orientation(items, W, H) {
    var f = null;
    for (var i = 0; i < FOCAL.length && !f; i++) for (var j = 0; j < items.length; j++) if (items[j].type === FOCAL[i]) { f = items[j]; break; }
    if (!f) return { edge: 'top', focal: null };
    var cx = num(f.x, 0) + num(f.width, 0) / 2, cy = num(f.y, 0) + num(f.height, 0) / 2;
    var d = { top: cy / H, bottom: 1 - cy / H, left: cx / W, right: 1 - cx / W };
    var edge = 'top';
    Object.keys(d).forEach(function (k) { if (d[k] < d[edge]) edge = k; });
    return { edge: edge, focal: f };
  }
  // plan point -> { depth 0 (at the stage) .. 1 (far end), lat 0 (guests' left) .. 1 (right) }
  function local(edge, cx, cy, W, H) {
    var u = cx / W, v = cy / H;
    if (edge === 'top') return { depth: v, lat: u };
    if (edge === 'bottom') return { depth: 1 - v, lat: 1 - u };
    if (edge === 'left') return { depth: u, lat: 1 - v };
    return { depth: 1 - u, lat: v };
  }
  function zone(p) {
    var d = p.depth < 0.34 ? 'front' : (p.depth < 0.67 ? 'middle' : 'back');
    var l = p.lat < 0.42 ? 'left' : (p.lat <= 0.58 ? 'centre' : 'right');
    return d === 'middle' && l === 'centre' ? 'centre' : (l === 'centre' ? d + '-centre' : d + '-' + l);
  }
  function edgeWord(edge) { return { top: 'top', bottom: 'bottom', left: 'left', right: 'right' }[edge]; }

  /* ---------- inventory: cluster same-type objects into groups (proximity), rows within a group ---------- */
  function boxGap(a, b) {
    var dx = Math.max(0, Math.max(a.x0, b.x0) - Math.min(a.x1, b.x1)), dy = Math.max(0, Math.max(a.y0, b.y0) - Math.min(a.y1, b.y1));
    return Math.max(dx, dy);
  }
  function ibox(it) { var x = num(it.x, 0), y = num(it.y, 0), w = Math.max(0, num(it.width, 0)), h = Math.max(0, num(it.height, 0));
    if (num(it.rotation, 0) % 180) { var cx = x + w / 2, cy = y + h / 2; return { x0: cx - h / 2, y0: cy - w / 2, x1: cx + h / 2, y1: cy + w / 2 }; }
    return { x0: x, y0: y, x1: x + w, y1: y + h }; }
  var NO_GROUP = { seatblock: 1, stage: 1, mandap: 1, dancefloor: 1, redcarpet: 1, walkway: 1, tent: 1, parking: 1 };   // each one is its own group
  function clusterType(list, aisleBox) {
    var n = list.length, parent = list.map(function (_, i) { return i; });
    function find(i) { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i; }
    var bx = list.map(ibox);
    for (var i = 0; i < n; i++) for (var j = i + 1; j < n; j++) {
      if (NO_GROUP[list[i].type]) continue;
      var a = bx[i], b = bx[j];
      var big = Math.max(a.x1 - a.x0, a.y1 - a.y0, b.x1 - b.x0, b.y1 - b.y0);
      var acx = (a.x0 + a.x1) / 2, acy = (a.y0 + a.y1) / 2, bcx = (b.x0 + b.x1) / 2, bcy = (b.y0 + b.y1) / 2;
      // aligned neighbours (same row or same column) may sit further apart than loose ones
      var aligned = Math.abs(acy - bcy) <= Math.max(1, 0.5 * Math.min(a.y1 - a.y0, b.y1 - b.y0)) || Math.abs(acx - bcx) <= Math.max(1, 0.5 * Math.min(a.x1 - a.x0, b.x1 - b.x0));
      var thr = aligned ? Math.max(3, 1.5 * big + 1) : Math.max(2, 0.5 * big);
      if (boxGap(a, b) > thr) continue;
      if (aisleBox) {   // never join two objects on opposite sides of the aisle
        var vert = (aisleBox.y1 - aisleBox.y0) >= (aisleBox.x1 - aisleBox.x0), mid = vert ? (aisleBox.x0 + aisleBox.x1) / 2 : (aisleBox.y0 + aisleBox.y1) / 2;
        var along = vert ? (acy >= aisleBox.y0 && acy <= aisleBox.y1) || (bcy >= aisleBox.y0 && bcy <= aisleBox.y1) : (acx >= aisleBox.x0 && acx <= aisleBox.x1) || (bcx >= aisleBox.x0 && bcx <= aisleBox.x1);
        if (along && (vert ? ((acx < mid) !== (bcx < mid)) : ((acy < mid) !== (bcy < mid)))) continue;
      }
      parent[find(i)] = find(j);
    }
    var by = {}, out = [];
    list.forEach(function (it, i) { var r = find(i); if (!by[r]) { by[r] = []; out.push(by[r]); } by[r].push(it); });
    return out;
  }
  // rows of a group: items whose centre depth (distance from the front) is within half an item depth
  function rowsOf(g, edge, W, H) {
    var pts = g.map(function (it) { var b = ibox(it); var p = local(edge, (b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, W, H);
      var dep = (edge === 'top' || edge === 'bottom') ? (b.y1 - b.y0) : (b.x1 - b.x0); return { d: p.depth * ((edge === 'top' || edge === 'bottom') ? H : W), dep: dep }; })
      .sort(function (a, b) { return a.d - b.d; });
    var rows = [];
    pts.forEach(function (p) { var r = rows[rows.length - 1]; if (r && Math.abs(p.d - r.d) <= Math.max(1, r.dep * 0.5)) r.n++; else rows.push({ d: p.d, dep: p.dep, n: 1 }); });
    return rows.map(function (r) { return r.n; });
  }
  function arrangement(g, name, rows) {
    var n = g.length;
    if (n === 1) return '1 ' + name;
    var same = rows.every(function (r) { return r === rows[0]; });
    if (rows.every(function (r) { return r === 1; })) return 'a line of ' + n + ' ' + plural(n, name) + ', one behind the other';
    if (rows.length === 1) return '1 row of ' + n + ' ' + plural(n, name) + ' side by side';
    if (same) return rows.length + ' rows x ' + rows[0] + ' ' + plural(rows[0], name) + ' = ' + n + ' ' + plural(n, name) + ' (' + rows.length + ' rows, one behind the other)';
    return rows.length + ' rows (' + rows.join(' + ') + ') = ' + n + ' ' + plural(n, name);
  }
  function groupBox(g) { var b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }; g.forEach(function (it) { var q = ibox(it); b.x0 = Math.min(b.x0, q.x0); b.y0 = Math.min(b.y0, q.y0); b.x1 = Math.max(b.x1, q.x1); b.y1 = Math.max(b.y1, q.y1); }); return b; }
  // where a group sits relative to another (front = toward the stage, left/right = guest facing the stage)
  function relation(a, b, edge, W, H, focal) {
    var pa = local(edge, (a.x0 + a.x1) / 2, (a.y0 + a.y1) / 2, W, H), pb = local(edge, (b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, W, H);
    var dd = (pa.depth - pb.depth) * ((edge === 'top' || edge === 'bottom') ? H : W), dl = (pa.lat - pb.lat) * ((edge === 'top' || edge === 'bottom') ? W : H);
    if (Math.abs(dd) >= Math.abs(dl)) return focal ? (dd < 0 ? 'at the back of' : 'just in front of') : (dd < 0 ? 'directly in front of (stage side of)' : 'directly behind');
    return dl < 0 ? 'to the left of' : 'to the right of';
  }
  function edgeOf(b, edge, W, H) {
    var m = 0.06 * Math.max(W, H), near = [];
    if (b.y0 <= m) near.push('top'); if (b.y1 >= H - m) near.push('bottom'); if (b.x0 <= m) near.push('left'); if (b.x1 >= W - m) near.push('right');
    var map = { top: { top: 'front', bottom: 'back', left: 'left', right: 'right' }, bottom: { top: 'back', bottom: 'front', left: 'right', right: 'left' },
      left: { left: 'front', right: 'back', top: 'right', bottom: 'left' }, right: { right: 'front', left: 'back', top: 'left', bottom: 'right' } }[edge];
    return near.map(function (k) { return map[k]; });
  }

  /* ---------- event-type profiles: the prompt first fixes WHAT kind of event this is, then styles only for it ----------
     florals: may florals appear at all; regional: may the regional (celebration) decor line apply;
     themes: decor-theme dropdown keys that fit; desc: object descriptions for this type; forbidden: explicit list. */
  var PROFILES = {
    wedding: { label: 'Wedding / reception / sangeet', florals: true, regional: true,
      themes: ['royal', 'pastel', 'whitegreen', 'minimal', 'rustic', 'arabian', 'bollywood'],
      summary: 'a celebration styled for a wedding - elegant, festive, rich in textiles and florals as designed',
      decor: 'elegant celebration decor on the existing objects: draped fabrics, florals on the existing floral objects, warm accents',
      palette: null, materials: 'silk and velvet fabrics, polished gold and brass, ivory linen', floral: null,
      signage: 'no signs or flags unless they exist as objects; any welcome board stays blank or unreadable',
      lighting: 'warm, flattering celebration lighting', stage: 'stage dressed with fabric skirting and the existing decor only',
      forbidden: ['political flags, banners or podium branding', 'corporate signage', 'concert beams or haze', 'readable text'] },
    political: { label: 'Political rally / public meeting', florals: false, regional: false, themes: ['rally', 'minimal', 'corporate'],
      summary: 'a functional public political rally - disciplined, open and practical; nothing celebratory or romantic',
      decor: 'functional rally dressing: plain-coloured flags and bunting (no readable text, no symbols), steel crowd barricades, practical stage dressing',
      palette: 'plain bold flag colours with white, steel grey and black', materials: 'steel barricades, black staging and truss, plain cloth, matting or open ground', floral: 'none - no flowers of any kind',
      signage: 'plain-coloured flags and bunting only, with no readable text, letters or symbols; any banner or screen shows no text',
      lighting: 'daylight or bright, even stage wash from truss lighting; line-array speakers and large LED walls glowing',
      stage: 'a podium with a plain neutral front on a stage with plain black / neutral skirting; press riser with cameras on tripods; generator tucked away',
      forbidden: ['flowers, florals, garlands or petals of any kind', 'floral arches or floral stands', 'wedding decor of any kind', 'couple / bridal chairs', 'chandeliers', 'candles', 'draped romantic fabrics', 'balloons', 'readable text, slogans, party symbols or logos'],
      desc: { stage: 'a raised stage deck with plain black / neutral skirting and a clean top', podium: 'a speaker podium / lectern with a plain neutral front (no text or symbol)',
        redcarpet: 'a plain carpet runner laid flat on the ground', walkway: 'a plain raised walkway / ramp', seatblock: 'a theatre-style seating block: rows of plain plastic or padded event chairs in neat straight rows',
        chairrow: 'a straight row of plain plastic or padded event chairs', chiavari: 'a plain plastic or padded event chair', table: 'a plain round table with a simple cloth', barricade: 'a line of steel crowd-control barricades',
        generator: 'a diesel power generator in a plain steel enclosure, set to one side', firstaid: 'a plain white first-aid tent with a small red cross marker', exit: 'a clear exit pathway kept free of chairs and people',
        press: 'a press riser platform with video cameras on tripods', led: 'a large LED wall glowing with an abstract visual (no readable text)', videowall: 'a large LED video wall glowing with an abstract visual (no readable text)',
        floral: 'a plain decorative stand in a neutral finish', floralarch: 'a plain arch frame in neutral cloth', headtable: 'a long dais table with plain cloth and simple chairs', sofa: 'a plain upholstered sofa for guests',
        arch: 'a plain arch frame in neutral cloth', drape: 'plain neutral fabric panels', desk: 'a plain registration desk' } },
    corporate: { label: 'Corporate / conference', florals: false, regional: false, themes: ['corporate', 'minimal'],
      summary: 'a clean, professional corporate event or conference - modern, tidy and brand-neutral',
      decor: 'clean modern dressing: a branding wall with no readable text, lecterns, modern furniture, neat cable management',
      palette: 'neutral whites, greys and charcoal with one calm brand accent colour', materials: 'matte laminates, brushed metal, upholstered modern seating, carpet tiles', floral: 'none - no wedding florals; at most plain green foliage on existing planters',
      signage: 'branding walls and screens show abstract graphics only, with no readable text or logos',
      lighting: 'even, bright, professional stage and room lighting', stage: 'a dark carpeted stage with a lectern and a clean LED backdrop if it exists as an object',
      forbidden: ['wedding florals, garlands or floral arches', 'wedding decor', 'couple chairs', 'balloons', 'readable text or logos'],
      desc: { stage: 'a raised stage with a dark carpeted top and a clean fascia', podium: 'a modern lectern with a clean neutral front (no text)', seatblock: 'a theatre-style block of upholstered conference chairs in neat rows',
        chairrow: 'a straight row of upholstered conference chairs', chiavari: 'a modern upholstered chair', table: 'a round table with crisp white linen and water glasses', floral: 'a plain green foliage planter', floralarch: 'a plain modern arch frame',
        brandwall: 'a clean branding wall with abstract graphics (no readable text)', redcarpet: 'a plain carpet runner laid flat on the ground', headtable: 'a panel table with a clean skirted front and chairs' } },
    concert: { label: 'Concert / music show', florals: false, regional: false, themes: ['concert', 'minimal'],
      summary: 'a live concert - high-energy staging, lighting beams and haze',
      decor: 'concert production: stage lighting beams, light haze, LED walls, crowd barricade, front-of-house tent',
      palette: 'deep blacks with saturated stage-light colours', materials: 'black staging, aluminium truss, steel barricades, matte black finishes', floral: 'none - no florals',
      signage: 'LED walls show abstract visuals with no readable text', lighting: 'dramatic coloured beams from moving lights through light haze, bright stage wash',
      stage: 'a black concert stage with truss, line-array speakers and LED walls as placed', forbidden: ['florals, garlands or floral arches', 'wedding decor', 'couple chairs', 'chandeliers', 'readable text or logos'],
      desc: { stage: 'a black concert stage deck with a black skirted front', seatblock: 'a block of plain black chairs in neat rows', chairrow: 'a straight row of plain black chairs', chiavari: 'a plain black chair',
        floral: 'a plain black decorative stand', floralarch: 'a plain black arch frame', foh: 'a front-of-house sound and lighting console in a small black tent', redcarpet: 'a plain dark carpet runner laid flat on the ground', table: 'a plain round table with a black cloth' } },
    exhibition: { label: 'Exhibition / expo', florals: false, regional: false, themes: ['corporate', 'minimal'],
      summary: 'a trade exhibition - orderly shell-scheme booths along carpeted aisles',
      decor: 'shell-scheme booths with blank fascia signage, carpeted aisles, display counters', palette: 'clean white booth walls with neutral grey carpet and calm accent colours',
      materials: 'white shell-scheme panels, aluminium frames, needle-punch carpet', floral: 'none - no florals', signage: 'booth fascias and signs are blank (no readable text or logos)',
      lighting: 'bright, even hall lighting with booth spotlights', stage: 'a simple presentation stage if it exists as an object',
      forbidden: ['wedding florals or floral arches', 'wedding decor', 'couple chairs', 'readable text or logos'],
      desc: { redcarpet: 'a carpeted aisle runner laid flat on the ground', floral: 'a plain green foliage planter', floralarch: 'a plain entrance arch frame', seatblock: 'a block of plain conference chairs in rows', chiavari: 'a plain chair', table: 'a plain round table with a simple cloth' } },
    birthday: { label: 'Birthday / party', florals: true, regional: false, themes: ['pastel', 'rustic', 'bollywood', 'whitegreen', 'minimal', 'royal'],
      summary: 'a joyful birthday party - colourful and playful', decor: 'colourful party decor on the existing objects; balloons and colourful accents allowed',
      palette: 'cheerful bright colours', materials: 'satin and sequinned fabrics, glossy finishes', floral: 'light florals on the existing floral objects only',
      signage: 'any banner or board stays blank or unreadable', lighting: 'bright, cheerful party lighting', stage: 'stage dressed with colourful fabric skirting',
      forbidden: ['political flags or banners', 'wedding mandap or couple chairs', 'readable text'] },
    iftar: { label: 'Iftar / majlis', florals: true, regional: false, themes: ['arabian', 'minimal', 'whitegreen', 'royal'],
      summary: 'a graceful iftar gathering - warm Middle-Eastern hospitality, majlis seating and lanterns as designed',
      decor: 'majlis-style hospitality on the existing objects: rich textiles, cushions, brass and lantern accents', palette: 'ivory, gold, deep teal and warm earth tones',
      materials: 'woven carpets, brocade cushions, brass and wood', floral: 'subtle white florals on the existing floral objects only', signage: 'no readable text',
      lighting: 'warm lantern-like lighting', stage: 'low, elegant stage dressing if a stage exists',
      forbidden: ['wedding mandap or couple chairs', 'political flags', 'concert beams or haze', 'alcohol or bar bottles', 'readable text'] },
  };
  function profileKey(eventType, items) {
    var e = String(eventType || '').toLowerCase();
    if (/politic|rally|campaign|election|public meeting|sabha/.test(e)) return 'political';
    if (/corporate|conference|seminar|summit|launch|meeting|award|agm|townhall|town hall/.test(e)) return 'corporate';
    if (/concert|music|gig|festival|live show|dj night/.test(e)) return 'concert';
    if (/exhibit|expo|trade ?show|fair/.test(e)) return 'exhibition';
    if (/birthday|party|baby shower|kids/.test(e)) return 'birthday';
    if (/iftar|ramadan|eid|majlis/.test(e)) return 'iftar';
    if (/wedding|reception|sangeet|mehndi|mehendi|haldi|engagement|nikah|shaadi/.test(e)) return 'wedding';
    // no (known) event type: infer from the objects on the plan
    var c = {}; (items || []).forEach(function (it) { if (it && it.type) c[it.type] = (c[it.type] || 0) + 1; });
    var has = function (t) { return c[t] || 0; };
    // big theatre-style crowd seating with no banquet tables = a public meeting, not a dinner
    var crowd = has('seatblock') + has('bleacher') >= 4 && !has('table') && !has('longtable') && !has('mandap');
    var sc = {
      wedding: 4 * has('mandap') + 3 * has('chariot') + 2 * (has('headtable') ? 1 : 0) + (has('floralarch') ? 2 : 0) + (has('caketable') ? 2 : 0) + (has('floral') ? 1 : 0) + (has('loveseat') ? 1 : 0),
      political: (crowd && (has('barricade') || has('firstaid') || has('generator')) ? 3 : 0) + 3 * (has('podium') ? 1 : 0) + 3 * (has('press') ? 1 : 0) + 2 * (has('barricade') ? 1 : 0) + 2 * (has('stagebarrier') ? 1 : 0) + (has('linearray') ? 1 : 0) + 3 * (has('flag') + has('flags') ? 1 : 0) + (has('checkpoint') ? 1 : 0),
      exhibition: has('booth') >= 3 ? 8 : 2 * has('booth'),
      concert: 2 * (has('linearray') ? 1 : 0) + 2 * (has('foh') ? 1 : 0) + 2 * (has('standing') + has('standingzone') ? 1 : 0) + (has('movinghead') ? 1 : 0) + (has('stagebarrier') ? 1 : 0),
      corporate: 2 * (has('desk') ? 1 : 0) + 2 * (has('brandwall') ? 1 : 0) + (has('podium') ? 1 : 0) + (has('ledscreen') ? 1 : 0),
      iftar: 4 * (has('majlis') + has('prayer') + has('prayerarea') ? 1 : 0),
      birthday: 4 * (has('balloon') + has('balloons') ? 1 : 0),
    };
    // a rally with a podium + press riser beats an incidental registration desk
    // wedding is only the fallback when there is NO evidence; any non-wedding evidence that is not
    // outweighed by wedding objects wins (a barricaded seating plan is never styled as a wedding)
    var best = 'wedding', bv = Math.max(1, sc.wedding);
    Object.keys(sc).forEach(function (k) { if (k !== 'wedding' && (sc[k] > bv || (sc[k] >= 2 && sc[k] === bv && !sc.wedding))) { bv = sc[k]; best = k; } });
    return best;
  }
  // event type for the render: the quote's type when it maps to a profile, else detected from the layout
  function detect(eventType, items) {
    var e = String(eventType || '').trim();
    var known = e && profileKey(e, []) !== 'wedding' || /wedding|reception|sangeet|mehndi|mehendi|haldi|engagement|nikah|shaadi/i.test(e);
    var key = profileKey(e, items);
    return { key: key, label: PROFILES[key].label, detected: !known, typeText: e };
  }
  function themesFor(eventType, items) { return PROFILES[profileKey(eventType, items)].themes.slice(); }
  // text cleaner for profiles without florals / wedding decor (never touches the FORBIDDEN lines)
  var NONFLORAL = [
    [/trees, hedges and flower beds/g, 'trees and hedges'], [/ on florals/g, ' on edges'], [/ and florals/g, ''], [/florals and /g, ''],
    [/mandap \/ /g, ''], [/ \/ mandap/g, ''], [/flower stands/g, 'decor stands'],
    [/\b(florals?|flowers?|roses?|marigolds?|petals?|hydrangeas?|orchids?|peonies|garlands?|bouquets?|posy)\b/gi, 'decor'],
    [/floral/gi, 'decor'], [/flower/gi, 'decor'], [/\bmandaps?\b/gi, 'ceremony stage'], [/\bcouples?\b/gi, 'VIP'], [/\bbridal\b/gi, 'VIP'], [/\bwedding\b/gi, 'event'],
  ];
  var PROFILE_ENV = {
    political: [
      [/a manicured green lawn and pale stone terrace/g, 'a large levelled open ground (a maidan / stadium-like open field) of packed earth and trimmed grass, with plain matting under the seating'],
      [/on a manicured (green )?lawn( and terrace)?/g, 'on a large levelled open ground (maidan)'],
      [/across the grass/g, 'across the ground'], [/vivid green grass, trees and hedges around the venue edges/g, 'open levelled ground with sparse grass and a few trees at the far edges'],
      [/Mature trees(,| and) hedges[^;.]*frame the venue edges/g, 'A few distant trees and open land frame the edges of the ground'],
      [/warm festoon string lights and fairy lights strung overhead/g, 'tall truss floodlights and stage lighting'], [/warm festoon \/ fairy string lights/g, 'tall truss floodlights'],
      [/warm festoon lighting, uplighting and candlelight/g, 'truss floodlights and bright stage wash'],
      [/,? ?candles on (the existing )?tables/g, ''], [/amber uplights washing the trees( and decor)?/g, 'floodlights washing the ground'], [/amber uplights on the existing decor and landscaping/g, 'floodlights on the ground'],
      [/pools of warm light on the lawn and dark landscaping beyond/g, 'pools of light on the open ground and dark surroundings beyond'],
      [/natural landscaping/g, 'open ground'], [/the lawn/g, 'the ground'],
      [/warm festoon string lights, uplighters, candles and stage lighting/g, 'truss floodlights and stage lighting'], [/warm festoon\/fairy lights and uplights glowing/g, 'truss floodlights and stage lighting glowing'],
      [/open-air lawn/g, 'open ground'], [/warm, glowing and romantic/g, 'clear, bright and purposeful'], [/warm and festive/g, 'bright and purposeful'], [/candles?/gi, 'lights'], [/festoon/gi, 'flood'],
    ],
  };
  function envFix(pk, text) {
    var R = PROFILE_ENV[pk]; if (!R) return text;
    return text.split('\n').map(function (l) { if (/FORBIDDEN/.test(l)) return l; R.forEach(function (r) { l = l.replace(r[0], r[1]); }); return l; }).join('\n');
  }
  // canonical event-type text per profile (the dialog's "change" override)
  var PROFILE_TYPE = { wedding: 'wedding', political: 'political rally', corporate: 'corporate event', concert: 'concert', exhibition: 'exhibition', birthday: 'birthday party', iftar: 'iftar' };
  // "Event: Political rally · 5,001 seats · 350×550 ft · Outdoor · 6 Oct 2026" - what the render will use
  function contextLine(o) {
    o = o || {};
    var items = (Array.isArray(o.items) ? o.items : []).filter(function (it) { return it && typeof it.type === 'string'; });
    var d = o.override && PROFILES[o.override] ? { key: o.override, label: PROFILES[o.override].label, detected: false, typeText: '' } : detect(o.eventType, items);
    var typeText = o.override ? PROFILES[o.override].label : (d.detected ? PROFILES[d.key].label + ' (detected from layout)' : clean(o.eventType, 40));
    var seats = 0; items.forEach(function (it) { if (!SKIP[it.type]) seats += seatsOf(it); });
    var w = o.world || {}, setting = inferSetting(o.setting, items);
    var parts = ['Event: ' + typeText];
    if (seats) parts.push(Math.round(seats).toLocaleString('en-US') + ' seats');
    if (num(w.w, 0) && num(w.h, 0)) parts.push(Math.round(w.w) + '\u00d7' + Math.round(w.h) + ' ft');
    parts.push(setting === 'outdoor' ? 'Outdoor' : 'Indoor');
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(o.eventDate || ''));
    if (m) parts.push((+m[3]) + ' ' + ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][+m[2] - 1] + ' ' + m[1]);
    return { text: parts.join(' \u00b7 '), profile: d.key, detected: !o.override && d.detected, eventType: o.override ? PROFILE_TYPE[o.override] : (d.detected ? PROFILE_TYPE[d.key] : clean(o.eventType, 40)) };
  }
  function deflower(text) {
    return text.split('\n').map(function (l) { if (/FORBIDDEN/.test(l)) return l; NONFLORAL.forEach(function (r) { l = l.replace(r[0], r[1]); }); return l; }).join('\n');
  }

  /* ---------- owner's master prompt (Helm Events geometry-preserving renderer) - filled values ---------- */
  // theme -> palette / florals / finishes (section 6). 'none' = only what the objects already imply.
  var THEME_FIELDS = {
    none: { palette: 'as implied by the objects as designed: ivory and gold chiavari chairs, cream / ivory sofas, white and ivory linen, natural greenery and soft floral tones', floral: 'only on the existing floral objects (arches, floral stands, centrepieces): roses, hydrangeas and greenery as designed', finish: 'gold chiavari chairs with ivory cushions, cream upholstered sofas, ivory linen, neatly skirted stage and tables' },
    royal: { palette: 'rich gold, deep red and ivory', floral: 'marigold and rose garlands on the existing florals and arches', finish: 'gold and carved finishes, rich red and ivory fabrics, brass accents on existing objects' },
    pastel: { palette: 'blush pink, ivory and soft sage', floral: 'blush and ivory roses, peonies and hydrangeas on the existing florals', finish: 'light sheer fabrics, ivory and gold furniture finishes' },
    whitegreen: { palette: 'white, ivory and fresh green', floral: 'white roses and orchids with lush green foliage on the existing florals', finish: 'crisp white linen, clean white and gold furniture' },
    minimal: { palette: 'neutral whites, greys and natural tones', floral: 'sculptural single-stem florals on the existing floral objects', finish: 'matte finishes, clean lines, uncluttered surfaces' },
    rustic: { palette: 'natural wood, warm whites and greens', floral: 'wildflowers and greenery on the existing florals', finish: 'natural wood, linen and burlap textures on existing furniture' },
    arabian: { palette: 'ivory and gold', floral: 'white orchids and roses on the existing florals', finish: 'mirrored and crystal accents, plush fabrics on existing furniture' },
    bollywood: { palette: 'bold jewel colours - magenta, orange and emerald with gold', floral: 'vivid roses and marigolds on the existing florals', finish: 'sequinned and draped fabrics on existing objects, sparkle accents' },
    corporate: { palette: 'crisp brand blue and white', floral: 'minimal white florals on the existing floral objects', finish: 'modern clean furniture finishes, tidy professional surfaces' },
    rally: { palette: 'plain bold flag colours with white', floral: 'minimal, only on existing floral objects', finish: 'sturdy practical finishes, clean stage dressing' },
    concert: { palette: 'deep blacks with saturated stage-light colours', floral: 'none beyond the existing floral objects', finish: 'black staging, metal truss and matte finishes' },
  };
  var LIGHT = {
    golden: { time: 'golden hour', mood: 'warm, glowing and romantic', sun: 'a low sun from camera-left (from the side of the venue), so long shadows fall across the ground toward the right', art: 'none needed - natural sunlight; existing stage and screen lights may glow softly', design: 'natural warm low sunlight with subtle accents on the existing stage and screens' },
    daylight: { time: 'midday', mood: 'bright, fresh and true-to-life', sun: 'high sun, slightly from the side opposite the camera, short shadows directly under objects', art: 'none - daylight only; LED screens on but subtle', design: 'clean natural daylight' },
    evening: { time: 'blue hour', mood: 'warm and festive against a cool dark sky', sun: 'the sun has set - only a faint glow on the horizon on the side opposite the camera', art: 'warm festoon / fairy string lights, amber uplights on the existing florals and landscaping, candles on the existing tables, stage and LED screens brightly lit', design: 'warm festoon lighting, uplighting and candlelight' },
    eveningIndoor: { time: 'indoor evening', mood: 'moody and intimate', sun: 'no sunlight (indoor, evening)', art: 'the venue\'s own fixtures dimmed, warm uplights, candlelight on the existing tables, stage and LED screens brightly lit', design: 'dimmed warm interior lighting with bright stage focus' },
    ballroom: { time: 'indoor evening', mood: 'elegant and warm', sun: 'no sunlight (indoor)', art: 'chandeliers and ceiling cove light, soft pin-spots on tables and florals, warm wall uplighting', design: 'warm ambient interior light with pin-spots on the existing tables and florals' },
  };
  var TIME_DEF = [
    'Morning: soft, cool-to-neutral low sun, gentle long shadows, fresh clear air.',
    'Midday: high sun, neutral white balance, short shadows directly under objects.',
    'Golden hour: low warm amber sun shortly before sunset, long soft shadows, glowing rim light.',
    'Blue hour: just after sunset, deep blue sky, the event lit by its own warm lights.',
    'Night: dark sky, the scene lit only by the event\'s own artificial lights.',
    'Indoor daylight: soft daylight entering the room, natural neutral colours, gentle shadows.',
    'Indoor evening: warm artificial light from the venue\'s own fixtures, dimmed ambient level, pools of light.',
  ];
  var WEATHER = { clear: 'clear sky', partly: 'partly cloudy - scattered soft clouds, sunlight still reaching the scene', overcast: 'overcast - an even layer of soft cloud, diffuse light and gentle shadows; keep the time-of-day colour' };
  function seasonOf(date, region) {
    var m = /^(\d{4})-(\d{2})/.exec(String(date || '')), mo = m ? +m[2] : 0;
    if (!(mo >= 1 && mo <= 12)) return 'not specified - mild, pleasant conditions typical of the region';
    if (region === 'AE') return mo >= 11 || mo <= 3 ? 'UAE winter - mild, clear and pleasant, soft sun' : 'UAE summer - hot, very bright sun, a light desert haze at the horizon';
    if (region === 'US') return mo === 12 || mo <= 2 ? 'winter - crisp air, evergreen or bare trees, no snow on the event area' : mo <= 5 ? 'spring - fresh green growth and blossom on the existing landscaping' : mo <= 8 ? 'summer - lush green landscaping, warm bright air' : 'autumn - warm-toned foliage on the surrounding trees';
    return mo === 12 || mo <= 2 ? 'Indian winter - cool, clear, dry air, soft winter sun, green lawns' : mo <= 5 ? 'Indian summer - hot, bright and dry, strong sun' : mo <= 9 ? 'monsoon season - lush deep-green vegetation, fresh damp air (no rain falling)' : 'post-monsoon autumn - clear, pleasant air and fresh green landscaping';
  }
  var COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
  function compass(deg) { deg = ((deg % 360) + 360) % 360; return COMPASS[Math.round(deg / 45) % 8]; }
  var SEATING = { sofa: 1, loveseat: 1, armchair: 1, chairrow: 1, seatblock: 1, chiavari: 1, bench: 1, bleacher: 1, ottoman: 0 };
  var FACES_AUDIENCE = { stage: 1, mandap: 1, led: 1, videowall: 1, ledscreen: 1, dj: 1, podium: 1, headtable: 1, brandwall: 1, photobooth: 1 };
  /* facing of one object (plan compass: north = top edge of the 2D plans, rotation clockwise in degrees).
     Seating at rotation 0 faces north; explicit rotation turns it; it is "faces <stage>" when the stage lies
     within 60 deg of that heading. Stage / screens / DJ face the guests (toward the venue centre). */
  function facingOf(it, W, H, stage, stageName) {
    var t = it.type, rot = num(it.rotation, 0), b = ibox(it), cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
    if (SEATING[t]) {
      var hd = rot;
      if (stage && stage !== it) {
        var sb = ibox(stage), dx = (sb.x0 + sb.x1) / 2 - cx, dy = (sb.y0 + sb.y1) / 2 - cy;
        var to = Math.atan2(dx, -dy) * 180 / Math.PI, diff = Math.abs((((to - hd) % 360) + 540) % 360 - 180);
        if (diff <= 60) return 'faces ' + stageName + ' (' + compass(hd) + ')';
      }
      return 'faces ' + compass(hd);
    }
    if (FACES_AUDIENCE[t]) {
      if (rot) return 'faces ' + compass(rot + 180);
      var ux = W / 2 - cx, uy = H / 2 - cy, wide = (b.x1 - b.x0) >= (b.y1 - b.y0);
      var d = wide ? (uy >= 0 ? 180 : 0) : (ux >= 0 ? 90 : 270);
      return 'faces guests (' + compass(d) + ')';
    }
    return rot ? 'rotated ' + Math.round(rot) + ' deg' : null;
  }
  var r1 = function (v) { return Math.round(num(v, 0) * 10) / 10; }, r2m = function (v) { return Math.round(num(v, 0) * 0.3048 * 100) / 100; };
  /* canonical event JSON (embedded as text - the image API takes only images + text).
     level 0: every object; 1: same-type groups of 2+ become one entry with ids; 2: ids as first..last;
     3: single objects of one type + size share one entry with every position.
     never drops an object: every entry carries its count. */
  function eventJson(level, ctx) {
    var objs = [], singles = {};
    ctx.groups.forEach(function (g) {
      if (level >= 3 && g.items.length === 1) {   // scattered single objects: one entry per type, every position kept
        var it1 = g.items[0], k = g.type + '|' + r1(it1.width) + '|' + r1(it1.height), e1 = singles[k];
        if (!e1) { e1 = singles[k] = { t: g.type, n: 0, each: { w: r1(it1.width), h: r1(it1.height) }, at: [], gs: [] }; objs.push(e1); }
        var f1 = facingOf(it1, ctx.W, ctx.H, ctx.stage, ctx.stageName);
        e1.n++; e1.at.push(num(it1.rotation, 0) ? [r1(it1.x), r1(it1.y), Math.round(num(it1.rotation, 0))] : [r1(it1.x), r1(it1.y)]); e1.gs.push(g.id);
        if (f1 && !e1.facing) e1.facing = f1;
        return;
      }
      if (level === 0 || g.items.length === 1) {
        g.items.forEach(function (it) {
          var o = { id: clean(it.id != null ? it.id : g.type, 32), t: g.type, x: r1(it.x), y: r1(it.y), w: r1(it.width), h: r1(it.height) };
          if (level < 2) { o.wm = r2m(it.width); o.hm = r2m(it.height); }
          if (level < 2 || num(it.rotation, 0)) o.rot = Math.round(num(it.rotation, 0));
          var f = facingOf(it, ctx.W, ctx.H, ctx.stage, ctx.stageName); if (f) o.facing = f;
          o.g = g.id;
          var p = it.properties || {};
          if (p.rows && p.cols) { o.rows = num(p.rows, 0); o.cols = num(p.cols, 0); o.seats = o.rows * o.cols; }
          else if (num(p.seats, 0) > 0) o.seats = num(p.seats, 0);
          objs.push(o);
        });
      } else {
        var it0 = g.items[0], ids = g.items.map(function (it) { return clean(it.id != null ? it.id : g.type, 32); });
        var e = { g: g.id, t: g.type, n: g.items.length, rows: rowsOf(g.items, ctx.edge, ctx.W, ctx.H), x: r1(g.box.x0), y: r1(g.box.y0), w: r1(g.box.x1 - g.box.x0), h: r1(g.box.y1 - g.box.y0),
          each: { w: r1(it0.width), h: r1(it0.height), wm: r2m(it0.width), hm: r2m(it0.height), rot: Math.round(num(it0.rotation, 0)) } };
        var ff = facingOf(it0, ctx.W, ctx.H, ctx.stage, ctx.stageName); if (ff) e.facing = ff;
        var s = 0; g.items.forEach(function (it) { s += seatsOf(it); }); if (s) e.seats = s;
        e.ids = level === 1 ? ids : ids[0] + ' .. ' + ids[ids.length - 1] + ' (' + ids.length + ')';
        if (level >= 3) delete e.each.wm, delete e.each.hm;
        objs.push(e);
      }
    });
    objs.forEach(function (e) { if (e.gs) e.gs = e.gs[0] + (e.gs.length > 1 ? ' .. ' + e.gs[e.gs.length - 1] : ''); });
    return JSON.stringify({ units: level < 2 ? 'ft (wm / hm in metres; 1 ft = 0.3048 m)' : 'ft (metres = ft x 0.3048)', axes: 'x to the right (east), y downward (south) from the top-left corner of the 2D plans; x,y = top-left of the object; rot = clockwise degrees (missing = 0); north = top edge of the plans',
      venue: { w: r1(ctx.W), h: r1(ctx.H), wm: r2m(ctx.W), hm: r2m(ctx.H), front: ctx.frontText, setting: ctx.where }, names: level < 2 ? ctx.names : undefined, objects: objs });
  }
  var PROMPT_LIMIT = 30000;   // OpenAI GPT image models accept up to 32,000 characters; render-photo also caps at 30,000
  var JSON_TARGET = 12000;

  function build(input) {
    input = input || {};
    var W = Math.max(10, num(input.world && input.world.w, 200)), H = Math.max(10, num(input.world && input.world.h, 140));
    var items = (Array.isArray(input.items) ? input.items : []).filter(function (it) { return it && typeof it.type === 'string'; });
    var setting = inferSetting(input.setting, items);
    var style = STYLES[input.style] ? input.style : defaultStyle(setting, !!input.evening);
    var env = envFor(style, setting);
    var camera = CAMERAS[input.camera] ? input.camera : 'auto';
    var region = regionOf(input.country);
    var pk = profileKey(input.eventType, items), prof = PROFILES[pk];
    var themeKey = input.themeKey && THEMES[input.themeKey] ? input.themeKey : null;
    if (themeKey && themeKey !== 'none' && prof.themes.indexOf(themeKey) < 0) themeKey = 'none';   // a theme that does not fit this event type is ignored
    var theme = themeKey ? THEMES[themeKey].text : clean(input.theme, 160);
    function descOf(t) { return (prof.desc && prof.desc[t]) || DESC[t] || NAMES[t] || clean(t, 30); }
    var focus = input.focus && FOCUS[input.focus] ? input.focus : null;
    var eventType = clean(input.eventType, 40) || { wedding: 'wedding', political: 'political rally', corporate: 'corporate event', concert: 'concert', exhibition: 'exhibition', birthday: 'birthday party', iftar: 'iftar' }[pk];
    var nImages = Math.max(1, Math.min(4, num(input.images, 4)));
    // extra quote context (styling cues only - names are NEVER rendered as text)
    var cx = [];
    if (clean(input.eventName, 60)) cx.push('event name "' + clean(input.eventName, 60) + '" (context only - never write it anywhere in the photo)');
    if (clean(input.venueName, 60)) cx.push('venue: ' + clean(input.venueName, 60));
    var place = [clean(input.city, 40), REGIONS[region] && input.country ? REGIONS[region].name : ''].filter(Boolean).join(', ');
    if (place) cx.push('location: ' + place);
    if (clean(input.menuPackage, 60) && pk !== 'political') cx.push('catering: ' + clean(input.menuPackage, 60) + ' (style any buffet / food stations to suit)');
    if (clean(input.seatColor, 30)) cx.push('chair colour: ' + clean(input.seatColor, 30));
    cx.push('chair colours in Image 1 are planning markers (red / amber = densely packed seating), not real chair colours');
    var ctxLine = 'CONTEXT: ' + cx.join('; ') + '.';
    var weather = WEATHER[input.weather] ? input.weather : 'clear';
    var quality = input.quality === 'high' ? 'high' : 'standard';
    var o = orientation(items, W, H);
    var stageItem = o.focal;

    var aisle = null;
    items.forEach(function (it) { if (!aisle && (it.type === 'redcarpet' || it.type === 'walkway')) aisle = it; });
    var aisleBox = aisle ? ibox(aisle) : null;
    var aisleLat = aisle ? local(o.edge, (aisleBox.x0 + aisleBox.x1) / 2, (aisleBox.y0 + aisleBox.y1) / 2, W, H).lat : null;

    var byType = {}, order = [], seats = 0;
    items.forEach(function (it) {
      if (SKIP[it.type]) return;
      if (!byType[it.type]) { byType[it.type] = []; order.push(it.type); }
      byType[it.type].push(it);
      seats += seatsOf(it);
    });
    var guests = num(input.guests, 0) > 0 ? Math.round(num(input.guests, 0)) : seats;

    // groups
    var groups = [], counts = {};
    order.forEach(function (t) {
      counts[t] = byType[t].length;
      clusterType(byType[t], t === 'redcarpet' || t === 'walkway' ? null : aisleBox).forEach(function (g) { groups.push({ type: t, items: g, box: groupBox(g) }); });
    });
    groups.forEach(function (g) { g.p = local(o.edge, (g.box.x0 + g.box.x1) / 2, (g.box.y0 + g.box.y1) / 2, W, H); });
    groups.sort(function (a, b) { return (a.p.depth - b.p.depth) || (a.p.lat - b.p.lat); });
    var typeGroups = {}; groups.forEach(function (g) { typeGroups[g.type] = (typeGroups[g.type] || 0) + 1; });
    var anchorTypes = ['seatblock', 'chairrow', 'dancefloor', 'stage', 'mandap', 'table', 'buffet'];
    function shortName(g) {
      var nm = NAMES[g.type] || clean(g.type, 30), side = '';
      if (typeGroups[g.type] > 1) side = (aisleLat != null && Math.abs(g.p.lat - aisleLat) > 0.02 ? (g.p.lat < aisleLat ? 'left ' : 'right ') : zone(g.p) + ' ');
      return 'the ' + side + nm + (g.items.length > 1 && g.type !== 'seatblock' ? ' group' : '');
    }
    var lines = [], shortLines = [], tinyLines = [], check = [];
    groups.forEach(function (g, gi) { g.id = 'G' + (gi + 1); });
    groups.forEach(function (g) {
      var t = g.type, n = g.items.length, name = NAMES[t] || clean(t, 30), it0 = g.items[0];
      var rows = rowsOf(g.items, o.edge, W, H);
      var what, total = n + ' ' + plural(n, name);
      if (t === 'seatblock' || t === 'chairrow') {
        var r = 0, ch = 0, per = [];
        g.items.forEach(function (it) { var p = it.properties || {}; var rr = num(p.rows, 1), cc = num(p.cols, 0) || (rr ? Math.round(seatsOf(it) / rr) : 0); r += rr; ch += seatsOf(it); per.push(rr + ' rows x ' + cc + ' chairs per row'); });
        if (per.length > 6) per = [per.slice(0, 3).join('; ') + '; ...'];
        what = (n > 1 ? n + ' ' + plural(n, name) + ' (' + per.join('; ') + ')' : 'one ' + name + ': ' + per[0]) + ' = ' + ch + ' chairs';
        total = (n > 1 ? n + ' blocks, ' : '') + r + ' rows, ' + ch + ' chairs';
      } else {
        what = arrangement(g.items, name, rows);
        var s = 0; g.items.forEach(function (it) { if (t !== 'sofa' && t !== 'chiavari') s += num((it.properties || {}).seats, 0); });
        if (s && /table/.test(t)) what += ' (' + s + ' seats in total)';
      }
      var where = ['at the ' + zone(g.p) + ' of the venue'];
      if (aisle && g.items.indexOf(aisle) < 0) {
        if (g.box.x1 <= aisleBox.x0 || g.box.x0 >= aisleBox.x1 || g.box.y1 <= aisleBox.y0 || g.box.y0 >= aisleBox.y1) {
          if (Math.abs(g.p.lat - aisleLat) > 0.02 && (t === 'seatblock' || t === 'chairrow' || t === 'sofa' || t === 'table' || t === 'floral' || t === 'pillar' || t === 'loveseat' || t === 'armchair'))
            where.push((g.p.lat < aisleLat ? 'LEFT' : 'RIGHT') + ' of the aisle');
        }
      }
      var best = null, bd = Infinity;
      groups.forEach(function (h) { if (h === g || h.type === t || anchorTypes.indexOf(h.type) < 0) return; var d = boxGap(g.box, h.box); if (d < bd) { bd = d; best = h; } });
      if (best && bd < 0.15 * Math.max(W, H) && anchorTypes.indexOf(t) < 0) where.push(relation(g.box, best.box, o.edge, W, H, stageItem && best.items.indexOf(stageItem) >= 0) + ' ' + shortName(best));
      var edges = edgeOf(g.box, o.edge, W, H);
      if (edges.length && t !== 'fence' && n > 1) where.push('along the ' + edges.join(' / ') + ' edge of the venue');
      var gw = Math.round(g.box.x1 - g.box.x0), gh = Math.round(g.box.y1 - g.box.y0);
      var size = n > 1 ? 'each about ' + ft(num(it0.width, 0)) + ' x ' + ft(num(it0.height, 0)) + ', group spans ' + gw + ' x ' + gh + ' ft' : 'about ' + ft(num(it0.width, 0)) + ' x ' + ft(num(it0.height, 0));
      var extra = t === 'sofa' && stageItem ? ', facing the ' + (NAMES[stageItem.type] || 'stage') : '';
      lines.push('- ' + g.id + ': ' + what + ' - ' + descOf(t) + '; ' + where.join(', ') + '; ' + size + extra + '.');
      tinyLines.push('- ' + g.id + ': ' + what + ' - ' + descOf(t) + '; ' + where[0] + '.');
      shortLines.push('- ' + g.id + ': ' + what + ' - ' + descOf(t) + '; ' + where.slice(0, 2).join(', ') + '.');
      check.push('- ' + g.id + ' ' + shortName(g).replace(/^the /, '') + ': ' + (t === 'seatblock' || t === 'chairrow' ? total : (n > 1 && rows.length > 1 && rows.some(function (r) { return r > 1; }) ? rows.length + ' rows, ' + total : (n > 1 && rows.length === 1 ? '1 row, ' : '') + total)));
    });

    var front = stageItem ? (NAMES[stageItem.type] || 'stage') : null;
    var edgeCompass = { top: 'north', bottom: 'south', left: 'west', right: 'east' }[o.edge];
    var orient = front
      ? 'The ' + front + ' is along the ' + edgeWord(o.edge) + ' edge of the 2D plans (' + edgeCompass + '); that is the FRONT of the venue. "Left" and "right" below are as seen by a guest facing the ' + front + '.'
      : 'There is no stage; "front" below means the top edge of the 2D plans, "left"/"right" as seen looking toward it.';

    /* ---- filled placeholders ---- */
    var outdoor = env.where === 'outdoor';
    var L = style === 'evening' && !outdoor ? LIGHT.eveningIndoor : LIGHT[style];
    var base = pk === 'wedding' ? THEME_FIELDS.none : { palette: prof.palette || THEME_FIELDS.none.palette, floral: prof.floral || THEME_FIELDS.none.floral, finish: prof.materials };
    var tf = themeKey && themeKey !== 'none' ? THEME_FIELDS[themeKey] : (theme && !themeKey ? { palette: 'as described by the planner\'s theme, applied to the existing objects', floral: 'as described by the planner\'s theme, only on the existing floral objects', finish: 'as described by the planner\'s theme, on the existing furniture' }  : base);
    if (!prof.florals) tf = { palette: tf.palette, floral: prof.floral, finish: tf.finish };
    var camTop = camera === 'top', camEye = camera === 'eye', camCur = camera === 'current';
    var aspect = camTop && H > W * 1.1 ? '2:3 portrait (1024 x 1536)' : '3:2 landscape (1536 x 1024)';
    var F = {
      VENUE_TYPE: outdoor ? 'open-air outdoor event venue' : (style === 'ballroom' || style === 'evening' ? 'indoor ballroom / banquet hall' : 'indoor event hall'),
      VENUE_SETTING: outdoor ? 'outdoor - open to the sky on a manicured lawn and terrace' : 'indoor - a fully enclosed room',
      WEATHER: outdoor ? WEATHER[weather] : 'not visible (indoor venue)',
      SEASON: seasonOf(input.eventDate, region) + (outdoor ? '' : ' (indoor venue: nothing outdoors is visible)'),
      EVENT_TYPE: eventType + (guests ? ' for about ' + guests + ' guests' : ''),
      DECOR_THEME: theme ? 'Decor theme requested by the planner: ' + theme + '.' : 'none - realistic decor matching the objects as designed; no added theme.',
      COLOR_PALETTE: tf.palette, FLORAL_STYLE: tf.floral, FURNITURE_FINISHES: tf.finish, LIGHTING_DESIGN: L.design,
      TIME_OF_DAY: L.time, LIGHTING_MOOD: L.mood, SUN_DIRECTION: L.sun, ARTIFICIAL_LIGHTING: L.art,
      CAMERA_MODE: camTop ? 'top-down nadir photograph' : camEye ? 'eye-level photograph' : camCur ? 'locked to Image 1 (the planner\'s chosen 3D view)' : 'locked to Image 1 (high three-quarter aerial)',
      CAMERA_POSITION: camTop ? 'directly above the centre of the venue, oriented exactly like Image 2 (same edge at the top)' : camEye ? 'at the guest entrance at the back of the venue, looking toward the ' + (front || 'front') + ' along the main aisle' : 'exactly as in Image 1 - same position, height and side of the venue in the foreground',
      CAMERA_ELEVATION: camTop ? '90 deg straight down' : camEye ? '1.6 m above the ground, level' : camCur ? 'as in Image 1' : 'about 40 deg looking down, as in Image 1',
      FOCAL_LENGTH: camEye ? '35 mm full-frame equivalent' : '24 mm full-frame equivalent',
      ASPECT_RATIO: aspect,
      IMAGE_QUALITY: quality === 'high' ? 'maximum detail - magazine-grade luxury event photography' : 'high-quality professional event photography',
    };

    var usedCats = {}; semanticMap(items, { w: W, h: H }).legend.forEach(function (l) { usedCats[l.key] = 1; });
    var legendText = CATS.filter(function (c) { return usedCats[c.key]; }).map(function (c) { return c.name; }).concat(usedCats.other ? [OTHER.name] : []).join('; ') || 'none';
    var roles = [
      'INPUT IMAGES (each has one job):',
      'Image 1: camera / composition reference - the actual 3D scene of the layout. Match its viewpoint, height, angle and framing exactly; replace every simplified grey shape with the real, richly detailed object.',
      'Image 2: top-down 2D floor plan without labels - ground truth for where every object stands.',
      'Image 3: the same plan with labels and measurements - use it ONLY to identify objects and read their sizes / scale; never draw any of it.',
    ];
    if (nImages >= 4) roles.push('Image 4: colour-coded semantic map (top-down, same orientation as Image 2): every flat colour patch is exactly one real object - use it to verify exact positions, rows and counts. Colour key: ' + legendText + '. White = empty ground. Never reproduce these flat colours.');
    roles.push('No style reference image is supplied - do not imagine or copy one.');

    var head = [
      'HELM EVENTS - GEOMETRY-PRESERVING PHOTOREALISTIC EVENT RENDERER',
      '',
      'ROLE: You are a professional architectural photographer, luxury event photographer, event-space visualization specialist and photorealistic renderer. Your task is to transform an existing, fully designed event scene into a premium, realistic photograph for a paying client. You are NOT designing a new event, NOT rearranging furniture and NOT inventing a better floor plan. Render the exact event the planner designed: ONE ultra-realistic professional event photograph of the planned ' + eventType + ' (not a 3D render, not an illustration). Change only the look (real materials, decor, light, environment); keep everything else exactly the same.',
      '',
      env.text,
      '',
      'EVENT TYPE (decided first - style ONLY for this type): ' + prof.label + ' (' + eventType + ') - ' + prof.summary + '.',
      '- Decor vocabulary: ' + prof.decor + '.',
      '- Colour palette: ' + (prof.palette || tf.palette) + '.',
      '- Materials: ' + prof.materials + '.',
      '- Florals: ' + (prof.florals ? (prof.floral || 'allowed on the existing floral objects, per the decor theme') : prof.floral) + '.',
      '- Signage and flags: ' + prof.signage + '.',
      '- Lighting design: ' + prof.lighting + '.',
      '- Stage dressing: ' + prof.stage + '.',
      '',
      roles.join('\n'),
    ].join('\n');

    var s1 = [
      '1. SOURCE-OF-TRUTH HIERARCHY',
      'Use the inputs in this order of priority:',
      '1) the canonical event JSON below - object identities, coordinates, dimensions, rotations, orientations, materials and relationships;',
      '2) the actual 3D scene (Image 1) - geometry and camera;',
      '3) the unlabeled 2D floor plan (Image 2) - secondary verification of positions;',
      '4) the dimensioned floor plan (Image 3) - only to identify objects and verify measurements; never reproduce its annotations;',
      nImages >= 4 ? '5) the colour-coded semantic map (Image 4) - verifies counts and positions only; never reproduce its colours;' : '',
      (nImages >= 4 ? '6' : '5') + ') style reference image - none is supplied, so take photographic quality, materials and finish from these instructions alone;',
      (nImages >= 4 ? '7' : '6') + ') the render settings in sections 5-8 (venue type, time of day, weather, lighting, camera, decor).',
      'When sources conflict, the higher priority always wins. Never combine conflicting layouts and never copy furniture or layout from a style reference.',
    ].filter(Boolean).join('\n');

    var s2 = [
      '2. GEOMETRY AND LAYOUT LOCK',
      '- Keep the layout EXACTLY as planned: same objects, same counts, same rows, same positions, same spacing and orientation. Preserve the position, rotation, dimensions and orientation of every object.',
      '- Keep the exact number of objects, rows, columns and seating blocks. Preserve all aisles, gaps, walking routes, entrances, exits and distances between objects.',
      '- Preserve the shapes and proportions of the stage, dance floor, seating areas, buffet, screens and venue boundaries.',
      '- Preserve the camera viewpoint, azimuth, elevation, focal perspective and framing of Image 1.',
      '- Do not add, remove, move, merge or duplicate any object, row, group, table or chair; do not resize, shift or rotate anything. Two separate groups stay two separate groups. Do not change the capacity.',
      '- Do not infer layout from any style reference and do not invent structures that are not in the source scene.',
      'ORIENTATION: ' + orient,
      aisle ? 'AISLE: a ' + (NAMES[aisle.type] || 'aisle') + ' runs ' + (aisleLat < 0.4 ? 'left of centre' : (aisleLat > 0.6 ? 'right of centre' : 'down the centre')) + ' from the back toward the ' + (front || 'front') + '; it splits the seating into a LEFT side and a RIGHT side.' : '',
      'VENUE: ' + (outdoor ? 'open-air outdoor venue' : 'indoor event space') + ', ' + ft(W) + ' wide x ' + ft(H) + ' deep.',
      'EVENT: ' + eventType + (guests ? ' for about ' + guests + ' guests' : '') + (seats ? ' (' + seats + ' seats on the plan)' : '') + '.',
      ctxLine,
    ].filter(Boolean).join('\n');

    var s3 = [
      '3. OBJECT ORIENTATION - CRITICAL',
      '- Preserve the rotation and front-facing direction of every sofa, chair, bench, table, stage and screen exactly as in the JSON "facing" field and Image 1.',
      '- Seating faces its target (normally the ' + (front || 'stage') + '). Never reverse, mirror or rotate seating toward the camera; keep every row in its row.',
      '- Preserve angled LED screens, the DJ booth and stage elements at their exact angles.',
      '- If an orientation is ambiguous, keep the source geometry exactly as it is.',
    ].join('\n');

    var s4 = [
      '4. REALISTIC OBJECT TRANSFORMATION',
      'Turn each placeholder into a realistic version of the SAME object, matching its dimensions, silhouette, footprint, orientation and location. Never split or merge objects and never substitute a different, merely similar object. Each object description below describes only that object\'s own materials and finish - it never adds other objects.',
    ].join('\n');

    var s5 = [
      '5. VENUE ENVIRONMENT',
      '- Venue type: ' + F.VENUE_TYPE + '.',
      '- Venue setting: ' + F.VENUE_SETTING + '.',
      '- Weather: ' + F.WEATHER + '.',
      '- Season: ' + F.SEASON + '.',
      outdoor
        ? '- Outdoor: render a true open-air venue - open sky, natural landscaping and natural light. Nothing overhead but sky: do not enclose the space or add any roof or structure that is not in the source scene or selected.'
        : '- Indoor: render a believable enclosed interior with its own ceiling, walls, flooring and interior lighting. No sky, no gardens and no direct sunlight.',
      '- Preserve the venue boundaries and footprint exactly.',
    ].join('\n');

    var s6 = [
      '6. EVENT STYLING',
      '- Event type: ' + F.EVENT_TYPE + '.',
      '- Decor theme: ' + F.DECOR_THEME,
      '- Colour palette: ' + F.COLOR_PALETTE + '.',
      '- Floral style: ' + F.FLORAL_STYLE + '.',
      '- Furniture finishes: ' + F.FURNITURE_FINISHES + '.',
      '- Lighting design: ' + F.LIGHTING_DESIGN + '.',
      prof.regional ? '- Regional finish: ' + REGIONS[region].text : '',
      '- Event-type decor: ' + prof.decor + '.',
      '- FORBIDDEN for this event type: ' + prof.forbidden.join('; ') + '.',
      '- Use believable materials, fabrics, florals and finishes. Decorate the existing objects without moving them. Do not introduce unselected arches, furniture, flower stands, screens, chandeliers, signs, water features or any other objects.',
    ].join('\n');

    s6 = s6.split('\n').filter(Boolean).join('\n');
    var s7 = [
      '7. LIGHTING AND TIME OF DAY',
      '- Time of day: ' + F.TIME_OF_DAY + '. ' + STYLES[style].light.charAt(0).toUpperCase() + STYLES[style].light.slice(1) + '.',
      '- Lighting mood: ' + F.LIGHTING_MOOD + '.',
      '- Sun direction: ' + F.SUN_DIRECTION + '.',
      '- Artificial lighting: ' + F.ARTIFICIAL_LIGHTING + '.',
      'Definitions: ' + TIME_DEF.join(' '),
      'Use only the selected lighting condition; never mix lighting from different times of day.',
    ].join('\n');
    if (outdoor) s7 = s7.replace(/chandeliers|ceiling|ballroom/gi, 'interior lights');

    var s8 = [
      '8. CAMERA AND PHOTOGRAPHIC QUALITY',
      '- Camera mode: ' + F.CAMERA_MODE + '.',
      '- Camera position: ' + F.CAMERA_POSITION + '.',
      '- Camera elevation: ' + F.CAMERA_ELEVATION + '.',
      '- Focal length: ' + F.FOCAL_LENGTH + '.',
      '- Aspect ratio: ' + F.ASPECT_RATIO + '.',
      '- Image quality: ' + F.IMAGE_QUALITY + '.',
      'CAMERA: ' + CAMERAS[camera].text,
      focus ? 'FOCUS: the photo should feature ' + FOCUS[focus].text + ' prominently - frame it as the hero of the picture while keeping everything else exactly as planned.' : '',
      '- Photorealistic: natural perspective, consistent scale, accurate materials, reflections and shadows, physically correct light, fine detail, sharp edges, realistic colour grading and appropriate depth of field with the whole venue clear.',
      '- No miniature / tilt-shift effect, no blur, no oversaturation, no plastic look, no artificial glow, no warped geometry, no CGI look, no cartoon look.',
      '- No people unless performers are part of the plan; the venue is styled and ready just before guests arrive.',
    ].filter(Boolean).join('\n');

    var s9 = [
      '9. TEXT AND SCREEN CONTENT',
      '- No text, letters, numbers, labels, captions, badges, legends, logos, watermarks, measurement lines, dimension arrows, grid lines, colour-coded patches, plan symbols or UI elements anywhere in the photo.',
      '- LED screens may show tasteful visuals that match the theme, without readable or misleading text.',
    ].join('\n');

    var totals = 'TOTALS BY TYPE: ' + order.map(function (t) { var n = counts[t], nm = NAMES[t] || clean(t, 30), x = '';
      if (t === 'seatblock' || t === 'chairrow') { var r = 0, c = 0; byType[t].forEach(function (it) { r += num((it.properties || {}).rows, 1); c += seatsOf(it); }); x = ' (' + r + ' rows, ' + c + ' chairs in total)'; }
      return n + ' ' + plural(n, nm) + x; }).join(', ') + '.';
    var s10head = [
      '10. FINAL VALIDATION',
      'Before finalising, check: the layout is preserved; every seating block is in place; every facing direction is correct; aisles and gaps are intact; screens, stage and tables are where planned; the venue is ' + (outdoor ? 'outdoor (open-air)' : 'indoor') + ' as selected; the lighting matches the time of day; the decor was applied without redesigning anything and fits a ' + prof.label.toLowerCase() + '; there are no annotations.'
      + '\n- FORBIDDEN check - none of these appear: ' + prof.forbidden.join('; ') + '.\nIf an exact constraint cannot be guaranteed, preserve the supplied scene - do not invent.',
    ].join('\n');
    var verify = 'Before finalising, verify every count, every row and every group in the checklist against Image 2' + (nImages >= 4 ? ' and Image 4' : '') + '; if anything is missing, merged or extra, fix it.';
    var finalOut = 'FINAL OUTPUT: ONE photorealistic event photograph with the same arrangement, the same orientation and the same camera. No plan, no collage, no alternatives, no text.';

    var names = {}; order.forEach(function (t) { names[t] = NAMES[t] || clean(t, 30); });
    var jctx = { groups: groups, W: W, H: H, edge: o.edge, stage: stageItem, stageName: front || 'stage', names: names, where: env.where,
      frontText: front ? edgeWord(o.edge) + ' edge (' + edgeCompass + ') - the ' + front : 'top edge (north) - no stage' };

    function assemble(level, maxLines, brief) {
      var json = eventJson(level, jctx);
      if (!prof.florals) json = deflower(json);
      json = envFix(pk, json);
      var inv = lines.length ? (brief === 2 ? tinyLines : brief ? shortLines : lines) : ['- (empty floor - show the styled venue only)'];
      var chk = check.length ? check : ['- nothing'];
      if (maxLines != null && inv.length > maxLines) inv = inv.slice(0, maxLines).concat(['- ... ' + (inv.length - maxLines) + ' more groups: see the canonical event JSON (every object is listed there).']);
      if (maxLines != null && chk.length > maxLines) chk = chk.slice(0, maxLines).concat(['- ... ' + (chk.length - maxLines) + ' more groups: counts as in the canonical event JSON.']);
      var system = [head, s1, s2, s3, s4, s5, s6, s7, s8, s9].join('\n\n');
      var layout = [
        'CANONICAL EVENT JSON (priority 1; every object - "g" = its inventory group, "facing" = its front direction):',
        json,
        'INVENTORY (human-readable companion to the JSON, front to back; every group must appear as its own group, with exactly this count and arrangement):',
        inv.join('\n'),
        s10head,
        'COUNT CHECKLIST (exact numbers - ' + groups.length + ' groups):',
        chk.join('\n'),
        brief === 2 ? '' : totals,
        verify,
        env.remind,
        finalOut,
      ].filter(Boolean).join('\n');
      if (!prof.florals) { system = deflower(system); layout = deflower(layout); }
      system = envFix(pk, system); layout = envFix(pk, layout);
      return { system: system, layout: layout, prompt: system + '\n\n' + layout, json: json, level: level };
    }
    var out = assemble(0, null);
    var nObj = groups.reduce(function (a, g) { return a + g.items.length; }, 0);
    if (nObj > 300 || out.json.length > JSON_TARGET || out.prompt.length > PROMPT_LIMIT) out = assemble(1, null);
    if (out.json.length > JSON_TARGET || out.prompt.length > PROMPT_LIMIT) out = assemble(2, null);
    if (out.json.length > JSON_TARGET || out.prompt.length > PROMPT_LIMIT) out = assemble(3, null);
    if (out.prompt.length > PROMPT_LIMIT) out = assemble(3, null, true);   // sizes are in the JSON: drop them from the inventory first
    if (out.prompt.length > PROMPT_LIMIT) out = assemble(3, null, 2);
    for (var ml = 120; out.prompt.length > PROMPT_LIMIT && ml >= 0; ml = ml > 20 ? ml - 20 : ml - 5) out = assemble(3, Math.max(0, ml), 2);
    if (out.prompt.length > PROMPT_LIMIT) {   // last resort: cut the middle of the data, never the end
      var tail = '\n\n' + [s10head, totals.slice(0, 2000), verify, env.remind, finalOut].join('\n');
      out.prompt = out.prompt.slice(0, PROMPT_LIMIT - tail.length) + tail;
    }
    return { profile: pk, style: style, camera: camera, region: region, theme: theme, focus: focus, environment: env.where, weather: weather, season: F.SEASON, fields: F,
      system: out.system, layout: out.layout, prompt: out.prompt, json: out.json, jsonLevel: out.level,
      stats: { seats: seats, guests: guests, counts: counts, orientation: o.edge, groups: groups.map(function (g) { return { id: g.id, type: g.type, count: g.items.length, rows: rowsOf(g.items, o.edge, W, H) }; }) } };
  }

  /* ---------- reference image 4: colour-coded semantic map (pure geometry; photo-render-ui.js draws it) ---------- */
  var CATS = [
    { key: 'chairs', color: '#00A6A6', name: 'teal = chairs / seating blocks', types: ['seatblock', 'chairrow', 'chiavari', 'bleacher', 'barstool'] },
    { key: 'sofas', color: '#E6007E', name: 'magenta = sofas / lounge furniture', types: ['sofa', 'loveseat', 'armchair', 'ottoman', 'lounge', 'bench', 'coffeetable', 'viprisers'] },
    { key: 'stage', color: '#1F3FFF', name: 'blue = stage / mandap / podium / head table', types: ['stage', 'mandap', 'podium', 'headtable', 'press'] },
    { key: 'screens', color: '#00D5FF', name: 'cyan = LED walls / screens', types: ['led', 'videowall', 'ledscreen'] },
    { key: 'dance', color: '#FFD400', name: 'yellow = dance floor', types: ['dancefloor'] },
    { key: 'aisle', color: '#E10000', name: 'red = aisle / red carpet / walkway', types: ['redcarpet', 'walkway'] },
    { key: 'floral', color: '#1E9E1E', name: 'green = florals / arches / planters / pillars', types: ['floral', 'floralarch', 'arch', 'planter', 'pillar', 'chariot'] },
    { key: 'tables', color: '#FF7A00', name: 'orange = guest / cake / gift tables', types: ['table', 'longtable', 'cocktail', 'caketable', 'gifttable'] },
    { key: 'food', color: '#8B4513', name: 'brown = buffet / bar / food stations', types: ['buffet', 'bar', 'truck', 'chocolatefountain'] },
    { key: 'av', color: '#7B2FF7', name: 'purple = DJ / sound / lighting gear', types: ['dj', 'speaker', 'linearray', 'subwoofer', 'monitor', 'foh', 'movinghead', 'truss', 'lighting', 'uplight', 'piano'] },
    { key: 'water', color: '#8FB8FF', name: 'light blue = fountain', types: ['fountain'] },
    { key: 'service', color: '#808080', name: 'grey = restrooms / service / back-of-house', types: ['restroom', 'greenroom', 'generator', 'firstaid', 'coatcheck', 'heater', 'parking', 'tent', 'canopy', 'booth'] },
    { key: 'edge', color: '#000000', name: 'black = fences / barriers / drapes', types: ['fence', 'barricade', 'stagebarrier', 'drape'] },
    { key: 'entry', color: '#FF9EC7', name: 'pink = welcome desk / photo booth / signage', types: ['desk', 'checkpoint', 'photobooth', 'easel', 'brandwall'] },
  ];
  var OTHER = { key: 'other', color: '#9A9A00', name: 'olive = other decor' };
  var CAT_OF = {}; CATS.forEach(function (c) { c.types.forEach(function (t) { CAT_OF[t] = c; }); });
  var LEGEND_TEXT = CATS.map(function (c) { return c.name; }).join('; ') + '; ' + OTHER.name;
  var UNDER = { dancefloor: 0, redcarpet: 0, walkway: 0, parking: 0, tent: 0 };
  function semanticMap(itemsIn, world) {
    var W = Math.max(10, num(world && world.w, 200)), H = Math.max(10, num(world && world.h, 140));
    var items = (Array.isArray(itemsIn) ? itemsIn : []).filter(function (it) { return it && typeof it.type === 'string' && !SKIP[it.type]; });
    var used = {};
    var shapes = items.map(function (it) {
      var c = CAT_OF[it.type] || OTHER; used[c.key] = c;
      return { type: it.type, cat: c.key, color: c.color, x: num(it.x, 0), y: num(it.y, 0), w: Math.max(0, num(it.width, 0)), h: Math.max(0, num(it.height, 0)), rot: num(it.rotation, 0), z: it.type in UNDER ? 0 : 1 };
    }).sort(function (a, b) { return a.z - b.z; });
    return { world: { w: W, h: H }, background: '#FFFFFF', shapes: shapes, legend: Object.keys(used).map(function (k) { return { key: k, color: used[k].color, name: used[k].name }; }) };
  }

  /* ---------- camera presets (pure; scene units: 1 ft, x right, y up, z = plan y, hall centred) ----------
     cameraView(kind, items, world, { aspect, fov, focus }) -> { kind, pos, target, fov, topDown?, ok, why? }
       kind 'auto'  : drone-style high three-quarter aerial from behind/above the entrance looking toward the
                      stage, ~40 deg down, ~12 deg off-centre, distance fitted so the whole hall is in frame
       kind 'focus' : same heading, closer aerial framing the chosen area (opts.focus: stage/dance/entrance/seating)
       kind 'top'   : straight-down framing of the hall
       kind 'eye'   : 1.6 m eye level at the entrance, nudged clear of every object, looking at the stage
     validView() checks: finite, eye cameras inside the hall + outside footprints, aerial cameras above every
     object and within the "aerial envelope" (hall grown by its longest side), target inside the hall. */
  var TALL = { tent: 22, truss: 20, lighting: 20, linearray: 22, videowall: 16, led: 14, stage: 6, mandap: 14, canopy: 12, chandelier: 14, arch: 10, floralarch: 10, ledscreen: 10 };
  function heightOf(t) { return TALL[t] || 5; }
  function boxOf(list) {
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    list.forEach(function (it) { x0 = Math.min(x0, it.x); y0 = Math.min(y0, it.y); x1 = Math.max(x1, it.x + it.width); y1 = Math.max(y1, it.y + it.height); });
    return { x0: x0, y0: y0, x1: x1, y1: y1 };
  }
  function norm3(v) { var L = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / L, v[1] / L, v[2] / L]; }
  function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  // smallest distance along -dir from target so every point fits in `fill` of the frustum
  function fitDistance(target, dir, pts, fovDeg, aspect, fill) {
    var F = norm3(dir), R = norm3(cross(F, [0, 1, 0])), U = cross(R, F);
    var tv = Math.tan(fovDeg * Math.PI / 360) * fill, th = tv * aspect;
    function fits(d) {
      var C = [target[0] - F[0] * d, target[1] - F[1] * d, target[2] - F[2] * d];
      return pts.every(function (p) { var v = [p[0] - C[0], p[1] - C[1], p[2] - C[2]], z = dot(v, F);
        return z > 0.5 && Math.abs(dot(v, R)) / z <= th && Math.abs(dot(v, U)) / z <= tv; });
    }
    var lo = 5, hi = 5;
    while (!fits(hi) && hi < 1e5) hi *= 1.6;
    for (var i = 0; i < 40; i++) { var m = (lo + hi) / 2; if (fits(m)) hi = m; else lo = m; }
    return hi;
  }
  // plan frame of the venue: front direction (unit, plan coords) + lateral, entrance point
  function venueFrame(items, W, H) {
    var o = orientation(items, W, H);
    var fwd = { top: [0, -1], bottom: [0, 1], left: [-1, 0], right: [1, 0] }[o.edge];
    var lat = [-fwd[1], fwd[0]];
    var back = { top: [W / 2, H], bottom: [W / 2, 0], left: [W, H / 2], right: [0, H / 2] }[o.edge];
    var aisle = items.filter(function (it) { return it.type === 'redcarpet' || it.type === 'walkway'; })[0];
    if (aisle) {   // entrance = the aisle's end farthest from the front
      var ac = [aisle.x + aisle.width / 2, aisle.y + aisle.height / 2];
      if (fwd[0] === 0) back = [ac[0], back[1]]; else back = [back[0], ac[1]];
    }
    var stage = o.focal ? [o.focal.x + o.focal.width / 2, o.focal.y + o.focal.height / 2] : null;
    return { edge: o.edge, fwd: fwd, lat: lat, entrance: back, stage: stage };
  }
  function blockerList(items) { return items.filter(function (it) { return !SKIP[it.type] && ['dancefloor', 'redcarpet', 'walkway', 'arch', 'floralarch', 'checkpoint'].indexOf(it.type) < 0 && it.width > 0 && it.height > 0; }); }
  function insideAny(p, list, pad) {
    return list.some(function (it) { var r = (num(it.rotation, 0) % 180) ? Math.hypot(it.width, it.height) / 2 : 0, cx = it.x + it.width / 2, cy = it.y + it.height / 2;
      var hw = r || it.width / 2, hh = r || it.height / 2;
      return Math.abs(p[0] - cx) < hw + pad && Math.abs(p[1] - cy) < hh + pad; });
  }
  function cameraView(kind, itemsIn, world, opts) {
    opts = opts || {};
    var W = Math.max(10, num(world && world.w, 200)), H = Math.max(10, num(world && world.h, 140));
    var items = (Array.isArray(itemsIn) ? itemsIn : []).filter(function (it) { return it && typeof it.type === 'string'; })
      .map(function (it) { return { type: it.type, rotation: num(it.rotation, 0), x: num(it.x, 0), y: num(it.y, 0), width: Math.max(0, num(it.width, 0)), height: Math.max(0, num(it.height, 0)) }; });
    var aspect = num(opts.aspect, 1.5) > 0.2 ? num(opts.aspect, 1.5) : 1.5, fov = Math.max(20, Math.min(90, num(opts.fov, 45)));
    var S = function (x, y, h) { return [x - W / 2, h, y - H / 2]; };
    var r2 = function (a) { return a.map(function (v) { return Math.round(v * 100) / 100; }); };
    var fr = venueFrame(items, W, H);
    var maxH = items.reduce(function (m, it) { return Math.max(m, heightOf(it.type)); }, 4);
    var out;
    if (kind === 'top') {
      var tgt = S(W / 2, H / 2, 0), d = fitDistance(tgt, [0, -1, -0.0001], [S(0, 0, 0), S(W, 0, 0), S(0, H, 0), S(W, H, 0)], fov, aspect, 0.92);
      out = { kind: 'top', topDown: true, pos: [tgt[0], Math.max(d, maxH + 10), tgt[2] + 0.01], target: tgt, fov: fov };
    } else if (kind === 'eye') {
      var look = fr.stage || [W / 2 + fr.fwd[0] * W / 2, H / 2 + fr.fwd[1] * H / 2];
      var e = [fr.entrance[0] + fr.fwd[0] * 3, fr.entrance[1] + fr.fwd[1] * 3], bl = blockerList(items), M = 2;
      var inH = function (q) { return q[0] >= M && q[0] <= W - M && q[1] >= M && q[1] <= H - M; };
      var clamp = function (q) { return [Math.max(M, Math.min(W - M, q[0])), Math.max(M, Math.min(H - M, q[1]))]; };
      e = clamp(e);
      if (insideAny(e, bl, 2)) {
        var found = null, dirs = [[-fr.fwd[0], -fr.fwd[1]], fr.lat, [-fr.lat[0], -fr.lat[1]], fr.fwd];
        for (var st = 0.5; st <= Math.max(W, H) && !found; st += 0.5) dirs.forEach(function (dd) { var q = [e[0] + dd[0] * st, e[1] + dd[1] * st]; if (!found && inH(q) && !insideAny(q, bl, 2)) found = q; });
        if (found) e = found;
      }
      out = { kind: 'eye', pos: S(e[0], e[1], 5.25), target: S(look[0], look[1], 4), fov: 65 };
    } else {
      // aerial: what to frame
      var area = null, focus = kind === 'focus' && FOCUS[opts.focus] ? opts.focus : null;
      if (focus) {
        var list = items.filter(function (it) { return FOCUS[focus].types.indexOf(it.type) >= 0; });
        if (list.length) { var b = boxOf(list), pad = 10 + 0.15 * Math.max(b.x1 - b.x0, b.y1 - b.y0); area = { x0: b.x0 - pad, y0: b.y0 - pad, x1: b.x1 + pad, y1: b.y1 + pad }; }
        else if (focus === 'entrance') { var en = fr.entrance, R0 = Math.min(W, H) * 0.3; area = { x0: en[0] - R0, y0: en[1] - R0, x1: en[0] + R0, y1: en[1] + R0 }; }
      }
      if (!area) area = { x0: 0, y0: 0, x1: W, y1: H };
      area = { x0: Math.max(0, area.x0), y0: Math.max(0, area.y0), x1: Math.min(W, area.x1), y1: Math.min(H, area.y1) };
      var cx = (area.x0 + area.x1) / 2, cy = (area.y0 + area.y1) / 2;
      if (!focus) {   // whole hall: aim a little toward the stage so the stage reads larger, aisle runs into frame
        var sh = 0.06 * (fr.fwd[0] ? W : H); cx += fr.fwd[0] * sh; cy += fr.fwd[1] * sh;
        if (!fr.stage && items.length) { var bb = boxOf(items); cx = (bb.x0 + bb.x1) / 2; cy = (bb.y0 + bb.y1) / 2; }
      }
      var pitch = (focus ? 38 : 40) * Math.PI / 180, yaw = 12 * Math.PI / 180;
      // horizontal heading = toward the front, rotated slightly off-centre
      var hx = fr.fwd[0] * Math.cos(yaw) + fr.lat[0] * Math.sin(yaw), hy = fr.fwd[1] * Math.cos(yaw) + fr.lat[1] * Math.sin(yaw);
      var dir = [hx * Math.cos(pitch), -Math.sin(pitch), hy * Math.cos(pitch)];
      var t3 = S(cx, cy, 0), hz = focus ? maxH : 4;
      var pts = [];
      [[area.x0, area.y0], [area.x1, area.y0], [area.x0, area.y1], [area.x1, area.y1]].forEach(function (c) { pts.push(S(c[0], c[1], 0)); pts.push(S(c[0], c[1], hz)); });
      var dist = fitDistance(t3, dir, pts, fov, aspect, 0.9);
      var F = norm3(dir), pos = [t3[0] - F[0] * dist, t3[1] - F[1] * dist, t3[2] - F[2] * dist];
      if (pos[1] < maxH + 8) pos[1] = maxH + 8;
      out = { kind: focus ? 'focus' : 'auto', focus: focus, pos: pos, target: t3, fov: fov };
    }
    out.pos = r2(out.pos); out.target = r2(out.target);
    var v = validView(out, items, { w: W, h: H });
    out.ok = v.ok; if (!v.ok) out.why = v.why;
    return out;
  }
  function validView(v, items, world) {
    var W = world.w, H = world.h;
    if (!v || !Array.isArray(v.pos) || !Array.isArray(v.target) || v.pos.concat(v.target).some(function (x) { return !isFinite(x); })) return { ok: false, why: 'not finite' };
    var px = v.pos[0] + W / 2, py = v.pos[2] + H / 2, tx = v.target[0] + W / 2, ty = v.target[2] + H / 2;
    if (tx < -0.01 || tx > W + 0.01 || ty < -0.01 || ty > H + 0.01) return { ok: false, why: 'target outside the hall' };
    if (Math.hypot(v.pos[0] - v.target[0], v.pos[1] - v.target[1], v.pos[2] - v.target[2]) < 1) return { ok: false, why: 'camera on its target' };
    if (v.kind === 'eye') {
      if (px < 0 || px > W || py < 0 || py > H) return { ok: false, why: 'eye camera outside the hall' };
      if (insideAny([px, py], blockerList(items), 0)) return { ok: false, why: 'eye camera inside an object' };
      return { ok: true };
    }
    var top = items.reduce(function (m, it) { return Math.max(m, heightOf(it.type)); }, 4);
    if (v.pos[1] <= top + 2) return { ok: false, why: 'aerial camera too low' };
    var E = Math.max(W, H);
    if (px < -E || px > W + E || py < -E || py > H + E) return { ok: false, why: 'aerial camera too far from the venue' };
    return { ok: true };
  }

  var api = { build: build, detect: detect, contextLine: contextLine, PROFILE_TYPE: PROFILE_TYPE, semanticMap: semanticMap, envFor: envFor, inferSetting: inferSetting, ENV: ENV, CATEGORIES: CATS, cameraView: cameraView, validView: validView, THEMES: THEMES, FOCUS: FOCUS, STYLES: STYLES, CAMERAS: CAMERAS, REGIONS: REGIONS, DESCRIPTIONS: DESC, PROFILES: PROFILES, profileKey: profileKey, themesFor: themesFor, WEATHER: WEATHER, seasonOf: seasonOf, facingOf: facingOf, PROMPT_LIMIT: PROMPT_LIMIT, defaultStyle: defaultStyle, regionOf: regionOf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.HelmPhotoPrompt = api;
})(typeof window !== 'undefined' ? window : this);
