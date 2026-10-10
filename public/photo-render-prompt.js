/* photo-render-prompt.js - HelmPhotoPrompt: turns a builder layout into a detailed, layout-exact
   prompt for the server-side photo render (edge function render-photo, migration 0095).
   PURE: no DOM, no network. Works in the browser (window.HelmPhotoPrompt) and in Node tests.

   build({ items, world:{w,h}, eventType, guests, setting, evening, style, camera, theme, country })
     -> { style, camera, system, layout, prompt, stats }
   The prompt has two blocks:
     1. a fixed instruction block (what the three reference images are, hard constraints:
        same layout / counts / positions, no text, no labels, no measurement lines, photographic)
     2. a layout block derived from the plan: hall size + orientation, every object type with
        its count, position (front / middle / back, left / centre / right relative to the stage,
        aisle sides), size and a photographic description (materials / colours) for the region. */
(function (root) {
  'use strict';

  var STYLES = {
    golden:   { label: 'Golden hour outdoor', light: 'warm golden-hour sunlight about 40 minutes before sunset, low sun raking from one side, long soft shadows, glowing rim light on florals and chairs, clear sky with a soft warm gradient', setting: 'outdoor' },
    evening:  { label: 'Evening lights',     light: 'blue-hour dusk just after sunset, deep blue sky, the event lit by warm festoon string lights, uplighters, candles and stage lighting, LED screens glowing, practical light pools on the ground, gentle haze', setting: null },
    daylight: { label: 'Daylight',           light: 'bright natural midday daylight, soft high clouds, true-to-life colours, gentle shadows directly under objects', setting: 'outdoor' },
    ballroom: { label: 'Indoor ballroom',    light: 'an elegant indoor ballroom: warm ambient light from chandeliers and ceiling coves, soft pin-spots on tables and florals, warm uplighting on walls and drapes, polished floor reflections', setting: 'indoor' },
  };
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
    rally:     { label: 'Political rally (flags & podium)', text: 'political rally styling - rows of plain coloured flags and bunting (no readable text or symbols), a prominent podium, bright daylight-style stage lighting' },
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
    IN: { name: 'India', text: 'Luxury Indian wedding decor: lush marigold, rose and jasmine florals, hanging floral strings, rose-petal accents, brass urlis and diyas, rich jewel-tone and ivory fabrics with gold accents.' },
    AE: { name: 'UAE', text: 'Dubai luxury event styling: white and champagne-gold palette, orchids and white roses, crystal and mirror accents, sleek modern furniture, manicured palms and desert landscaping.' },
    US: { name: 'USA', text: 'Upscale American event styling: white hydrangeas, garden roses and abundant greenery, natural wood and brushed brass accents, bistro string lights, classic clean lines.' },
  };

  /* every ASSETS type in builder.js -> a photographic description (materials / colours) */
  var DESC = {
    stage: 'a raised event stage with a carpeted deck, skirted front, a large LED backdrop wall framed by lush floral installations',
    dancefloor: 'a glossy black-and-white checkered dance floor laid flat on the ground',
    podium: 'a slim lectern podium in white and gold',
    press: 'a low black press riser platform for photographers and cameras',
    dj: 'a DJ booth with a glowing LED facade, decks and a pair of speakers',
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
    photobooth: 'a photo booth backdrop with a floral wall and a small ring light',
    checkpoint: 'a security checkpoint with a walk-through frame and a small table',
    bar: 'an illuminated bar counter with a polished top, bottles on a back shelf and bar stools',
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
    redcarpet: 'a red carpet aisle runner laid on the ground, lined with tall floral stands and chrome stanchions',
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
    foh: 'a front-of-house sound and lighting console position under a small canopy',
    movinghead: 'a moving-head stage light',
    videowall: 'a large LED video wall glowing with an abstract visual (no readable text)',
    generator: 'a silent power generator in an enclosure, tucked away discreetly',
    distro: 'a small power distribution box',
    cableramp: 'a low cable ramp protector on the ground',
    greenroom: 'a private green room tent / cabin',
    viprisers: 'a raised VIP riser platform with lounge seating',
    stagebarrier: 'a black steel stage barrier line',
    lighting: 'an overhead lighting truss span with stage lights and warm wash fixtures',
    led: 'a large LED wall glowing with a soft floral / abstract visual (no readable text)',
    chocolatefountain: 'a tall chocolate fountain on a dressed table',
    chariot: 'an ornate decorated wedding chariot / carriage in white and gold with florals',
    smoke: 'a small low-fog machine (subtle haze, not visible as an object)',
    dancers: 'a group of performers in coordinated costumes',
    walkway: 'a raised carpeted walkway / ramp lined with floral stands',
    brandwall: 'a decorative branding / welcome wall with florals (no readable text)',
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
  function defaultStyle(setting, evening) {
    if (evening) return 'evening';
    return setting === 'indoor' ? 'ballroom' : 'golden';
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

  function build(input) {
    input = input || {};
    var W = Math.max(10, num(input.world && input.world.w, 200)), H = Math.max(10, num(input.world && input.world.h, 140));
    var items = (Array.isArray(input.items) ? input.items : []).filter(function (it) { return it && typeof it.type === 'string'; });
    var setting = input.setting === 'outdoor' ? 'outdoor' : (input.setting === 'indoor' ? 'indoor' : 'outdoor');
    var style = STYLES[input.style] ? input.style : defaultStyle(input.setting, !!input.evening);
    var camera = CAMERAS[input.camera] ? input.camera : 'auto';
    var region = regionOf(input.country);
    var themeKey = input.themeKey && THEMES[input.themeKey] ? input.themeKey : null;
    var theme = themeKey ? THEMES[themeKey].text : clean(input.theme, 160);
    var focus = input.focus && FOCUS[input.focus] ? input.focus : null;
    var eventType = clean(input.eventType, 40) || 'wedding';
    var o = orientation(items, W, H);
    var stageItem = o.focal;

    // aisle: a red carpet / walkway running away from the stage
    var aisle = null;
    items.forEach(function (it) { if (!aisle && (it.type === 'redcarpet' || it.type === 'walkway')) aisle = it; });
    var aisleLat = aisle ? local(o.edge, num(aisle.x, 0) + num(aisle.width, 0) / 2, num(aisle.y, 0) + num(aisle.height, 0) / 2, W, H).lat : null;

    // group by type
    var groups = {}, order = [], seats = 0;
    items.forEach(function (it) {
      if (SKIP[it.type]) return;
      if (!groups[it.type]) { groups[it.type] = []; order.push(it.type); }
      groups[it.type].push(it);
      seats += seatsOf(it);
    });
    var guests = num(input.guests, 0) > 0 ? Math.round(num(input.guests, 0)) : seats;

    var lines = [], counts = {};
    order.forEach(function (t) {
      var g = groups[t], n = g.length, name = NAMES[t] || clean(t, 30);
      counts[t] = n;
      var zs = {}, sides = { left: 0, right: 0 };
      g.forEach(function (it) {
        var w = num(it.width, 0), h = num(it.height, 0);
        var p = local(o.edge, num(it.x, 0) + w / 2, num(it.y, 0) + h / 2, W, H);
        var z = zone(p); zs[z] = (zs[z] || 0) + 1;
        if (aisleLat != null && it !== aisle) { if (p.lat < aisleLat - 0.02) sides.left++; else if (p.lat > aisleLat + 0.02) sides.right++; }
      });
      var where = Object.keys(zs).map(function (z) { return (n > 1 ? zs[z] + ' at ' : 'at ') + 'the ' + z; }).join(', ');
      var sz = g[0];
      var size = ft(num(sz.width, 0)) + ' x ' + ft(num(sz.height, 0));
      var extra = '';
      if (t === 'seatblock' || t === 'chairrow') {
        var rows = 0, chairs = 0;
        g.forEach(function (it) { var p = it.properties || {}; rows += num(p.rows, 1); chairs += seatsOf(it); });
        extra = '; ' + chairs + ' chairs in total across ' + rows + ' rows (exactly this many rows - no extra rows)';
      } else if (t === 'table' || t === 'longtable' || t === 'headtable' || t === 'cocktail') {
        var s = 0; g.forEach(function (it) { s += seatsOf(it); });
        if (s) extra = '; ' + s + ' seats in total';
      }
      if (aisle && t !== aisle.type && sides.left && sides.right && (t === 'seatblock' || t === 'chairrow' || t === 'sofa' || t === 'floral' || t === 'barricade' || t === 'pillar' || t === 'table'))
        extra += '; ' + sides.left + ' on the left and ' + sides.right + ' on the right of the aisle';
      if (t === 'sofa' && stageItem) extra += '; placed in front of the seating, facing the stage';
      lines.push('- ' + n + ' ' + plural(n, name) + ' (' + (DESC[t] || name) + '), ' + (n > 1 ? 'each ' : '') + 'about ' + size + ', ' + where + extra + '.');
    });

    var front = stageItem ? (NAMES[stageItem.type] || 'stage') : null;
    var orient = front
      ? 'The ' + front + ' is along the ' + edgeWord(o.edge) + ' edge of the 2D plans; that is the FRONT of the venue. "Left" and "right" below are as seen by a guest facing the ' + front + '.'
      : 'There is no stage; "front" below means the top edge of the 2D plans, "left"/"right" as seen looking toward it.';

    var system = [
      'Create ONE ultra-realistic professional event photograph (not a 3D render, not an illustration) of the planned event shown in the reference images.',
      'Reference image 1 is a simple 3D model of the layout: use it for the camera angle, the exact positions, proportions and counts of every object - then replace every simplified shape with the real, richly detailed object described below.',
      'Reference image 2 is the 2D floor plan without labels (top-down): it is the ground truth for where every object stands.',
      'Reference image 3 is the same 2D plan with labels and measurements: use it ONLY to identify objects and read their sizes - never draw any of it.',
      'STRICT RULES:',
      '- Keep the layout EXACTLY as planned: same objects, same counts, same positions, same spacing and orientation. Do not add, remove, move or duplicate any object, row, table or chair; do not add extra rows of seating.',
      '- No text, letters, numbers, labels, badges, legends, logos, watermarks, measurement lines, dimension arrows, grid lines or plan symbols anywhere in the photo.',
      '- Photorealistic: real materials, physically correct light and shadows, natural colour, fine detail, no CGI look, no cartoon look, no tilt-shift miniature effect.',
      '- No people unless performers are part of the plan; the venue is styled and ready just before guests arrive.',
    ].join('\n');

    var layout = [
      'EVENT: ' + eventType + (guests ? ' for about ' + guests + ' guests' : '') + (seats ? ' (' + seats + ' seats on the plan)' : '') + '.',
      'VENUE: ' + (setting === 'indoor' ? 'indoor hall / ballroom' : 'outdoor lawn venue') + ', ' + ft(W) + ' wide x ' + ft(H) + ' deep.',
      'ORIENTATION: ' + orient,
      aisle ? 'AISLE: a ' + (NAMES[aisle.type] || 'aisle') + ' runs ' + (aisleLat < 0.4 ? 'left of centre' : (aisleLat > 0.6 ? 'right of centre' : 'down the centre')) + ' from the back toward the ' + (front || 'front') + '.' : '',
      'OBJECTS (every one of them must appear, with exactly these counts and positions):',
      lines.length ? lines.join('\n') : '- (empty floor - show the styled venue only)',
      'GROUND & SURROUNDINGS: ' + (setting === 'indoor'
        ? 'polished ballroom floor or patterned carpet, elegant walls with drapes, ceiling with soft lighting.'
        : 'manicured green lawn with neat landscaping, hedges, trees and flower beds around the edges; paths between areas.'),
      'STYLE & DECOR: ' + REGIONS[region].text + (theme ? ' Decor theme requested by the planner: ' + theme + '.' : ''),
      'LIGHT & TIME: ' + STYLES[style].light + '.',
      'CAMERA: ' + CAMERAS[camera].text,
      focus ? 'FOCUS: the photo should feature ' + FOCUS[focus].text + ' prominently - frame it as the hero of the picture while keeping everything else exactly as planned.' : '',
    ].filter(Boolean).join('\n');

    var prompt = system + '\n\n' + layout;
    if (prompt.length > 30000) prompt = prompt.slice(0, 30000);
    return { style: style, camera: camera, region: region, theme: theme, focus: focus, system: system, layout: layout, prompt: prompt,
      stats: { seats: seats, guests: guests, counts: counts, orientation: o.edge } };
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

  var api = { build: build, cameraView: cameraView, validView: validView, THEMES: THEMES, FOCUS: FOCUS, STYLES: STYLES, CAMERAS: CAMERAS, REGIONS: REGIONS, DESCRIPTIONS: DESC, defaultStyle: defaultStyle, regionOf: regionOf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.HelmPhotoPrompt = api;
})(typeof window !== 'undefined' ? window : this);
