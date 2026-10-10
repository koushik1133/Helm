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
    eye:  { label: 'Eye-level from entrance', text: 'Eye-level photograph from the guest entrance at the back of the venue, camera at 1.6 m height looking toward the stage along the main aisle, 35mm lens at f/5.6, natural perspective with the stage as the focal point.' },
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
    var camera = CAMERAS[input.camera] ? input.camera : 'hero';
    var region = regionOf(input.country);
    var theme = clean(input.theme, 160);
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
    ].filter(Boolean).join('\n');

    var prompt = system + '\n\n' + layout;
    if (prompt.length > 30000) prompt = prompt.slice(0, 30000);
    return { style: style, camera: camera, region: region, system: system, layout: layout, prompt: prompt,
      stats: { seats: seats, guests: guests, counts: counts, orientation: o.edge } };
  }

  var api = { build: build, STYLES: STYLES, CAMERAS: CAMERAS, REGIONS: REGIONS, DESCRIPTIONS: DESC, defaultStyle: defaultStyle, regionOf: regionOf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.HelmPhotoPrompt = api;
})(typeof window !== 'undefined' ? window : this);
