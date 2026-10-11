// render-master-prompt.test.mjs - the owner's "Helm Events geometry-preserving photorealistic event renderer"
// master prompt: 10 sections in order, every placeholder filled for every style / camera / theme / weather combo,
// embedded canonical event JSON (every object id + facing), no added objects in descriptions, length limits.
// NO network: fetch is stubbed to throw; nothing here calls the image service.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const rd = (p) => readFileSync(join(ROOT, p), 'utf8');
globalThis.fetch = () => { throw new Error('network is not allowed in this test'); };
const P = createRequire(import.meta.url)('../public/photo-render-prompt.js');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('  ✓ ' + name); };

// the owner's fixture: stage at the top, 1 row x 8 sofas LEFT, 2 rows x 8 sofas RIGHT, blocks 16x25 / 20x25
const I = (type, x, y, width, height, properties, rotation) => ({ id: type + '-' + x + '-' + y, type, x, y, width, height, rotation: rotation || 0, properties: properties || {} });
const sofas = (x0, y, k) => Array.from({ length: k }, (_, i) => I('sofa', x0 + i * 6.5, y, 6, 3, { seats: 3 }));
const OWNER = [
  I('stage', 75, 3, 50, 16), I('led', 85, 1, 30, 1.5), I('dj', 20, 10, 8, 5), I('led', 18, 2, 14, 1.5),
  I('dancefloor', 88, 22, 24, 16),
  I('seatblock', 44, 50, 50, 48, { rows: 16, cols: 25 }), I('seatblock', 106, 50, 50, 60, { rows: 20, cols: 25 }),
  ...sofas(43, 45, 8), ...sofas(105, 40.5, 8), ...sofas(105, 45, 8),
  I('redcarpet', 97, 40, 6, 80), I('redcarpet', 103, 114, 97, 6),
  I('floralarch', 130, 112, 2, 10), I('floralarch', 145, 112, 2, 10), I('floralarch', 160, 112, 2, 10), I('floralarch', 175, 112, 2, 10),
  I('fountain', 185, 95, 8, 8), I('videowall', 192, 45, 2, 24),
  ...[20, 45, 70, 105, 130, 155].map((x) => I('buffet', x, 132, 18, 3)),
  I('fence', 0, 138, 200, 1), I('caketable', 160, 26, 5, 5), I('restroom', 4, 110, 12, 8), I('exit', 186, 126, 12, 6),
];
const W = { w: 200, h: 140 };
const build = (o) => P.build(Object.assign({ items: OWNER, world: W, eventType: 'Wedding', setting: 'outdoor', country: 'IN', eventDate: '2026-12-12', style: 'golden', camera: 'auto', themeKey: 'none' }, o || {}));

const SECTIONS = ['1. SOURCE-OF-TRUTH HIERARCHY', '2. GEOMETRY AND LAYOUT LOCK', '3. OBJECT ORIENTATION - CRITICAL', '4. REALISTIC OBJECT TRANSFORMATION',
  '5. VENUE ENVIRONMENT', '6. EVENT STYLING', '7. LIGHTING AND TIME OF DAY', '8. CAMERA AND PHOTOGRAPHIC QUALITY', '9. TEXT AND SCREEN CONTENT', '10. FINAL VALIDATION'];

t('all 10 sections present, in order, with the owner\'s key sentences; FINAL OUTPUT last', () => {
  const p = build().prompt;
  assert.ok(p.startsWith('HELM EVENTS - GEOMETRY-PRESERVING PHOTOREALISTIC EVENT RENDERER\n'));
  let at = p.indexOf('ROLE: '); assert.ok(at > 0);
  for (const s of SECTIONS) { const i = p.indexOf('\n' + s + '\n'); assert.ok(i > at, s); at = i; }
  for (const re of [/NOT designing a new event, NOT rearranging furniture and NOT inventing a better floor plan/, /Render the exact event the planner designed/,
    /When sources conflict, the higher priority always wins/, /never copy furniture or layout from a style reference/,
    /Do not add, remove, move, merge or duplicate any object/, /Do not change the capacity/, /Seating faces its target/, /Never reverse, mirror or rotate seating toward the camera/,
    /If an orientation is ambiguous, keep the source geometry/, /Never split or merge objects and never substitute a different, merely similar object/,
    /Do not introduce unselected arches, furniture, flower stands, screens, chandeliers, signs, water features or any other objects/,
    /never mix lighting from different times of day/, /No miniature \/ tilt-shift effect/, /LED screens may show tasteful visuals/,
    /If an exact constraint cannot be guaranteed, preserve the supplied scene - do not invent/, /No style reference image is supplied/]) assert.match(p, re);
  assert.match(p, /\nFINAL OUTPUT: ONE photorealistic event photograph with the same arrangement, the same orientation and the same camera\. No plan, no collage, no alternatives, no text\.$/);
  // image roles + hierarchy with the semantic map below JSON + 3D
  assert.match(p, /Image 1: camera \/ composition reference/); assert.match(p, /Image 4: colour-coded semantic map/);
  assert.match(p, /1\) the canonical event JSON[^\n]*\n2\) the actual 3D scene \(Image 1\)[^\n]*\n3\) the unlabeled 2D floor plan \(Image 2\)[^\n]*\n4\) the dimensioned floor plan \(Image 3\)[^\n]*\n5\) the colour-coded semantic map \(Image 4\)[^\n]*\n6\) style reference image - none is supplied/);
  // environment right after ROLE, inventory + checklist inside, checklist inside section 10, reminder before FINAL OUTPUT
  assert.ok(p.indexOf('ENVIRONMENT (mandatory') < p.indexOf('1. SOURCE-OF-TRUTH'));
  assert.ok(p.indexOf('COUNT CHECKLIST') > p.indexOf('10. FINAL VALIDATION'));
  assert.match(p, /2 rows x 8 sofas = 16 sofas/);
  assert.match(p, /Reminder: [^\n]*\nFINAL OUTPUT/);
});

t('every placeholder filled for every style / camera / theme / weather / country / date - no {{ and no empty value', () => {
  let k = 0;
  for (const style of Object.keys(P.STYLES)) for (const camera of Object.keys(P.CAMERAS)) for (const themeKey of Object.keys(P.THEMES).concat([null]))
    for (const weather of ['clear', 'partly', 'overcast']) for (const country of ['IN', 'AE', 'US']) for (const eventDate of ['2026-07-01', '', '2027-02-14']) {
      if (k++ % 3 && themeKey !== 'none') continue;   // sample: full grid on 'none', a third elsewhere
      const r = build({ style, camera, themeKey, theme: themeKey ? '' : 'teal and copper', weather, country, eventDate, setting: k % 2 ? 'indoor' : 'outdoor' });
      assert.doesNotMatch(r.prompt, /\{\{|\}\}|undefined|null\b|NaN/, [style, camera, themeKey].join('/'));
      assert.doesNotMatch(r.prompt, /: \.|: $|- \.$/m);
      for (const [f, v] of Object.entries(r.fields)) assert.ok(String(v).trim().length > 2, f);
    }
  // spot values
  const g = build();
  assert.equal(g.fields.TIME_OF_DAY, 'golden hour'); assert.match(g.fields.SUN_DIRECTION, /camera-left/);
  assert.match(g.fields.CAMERA_ELEVATION, /40 deg/); assert.match(g.fields.FOCAL_LENGTH, /^24 mm/); assert.match(g.fields.ASPECT_RATIO, /3:2/);
  assert.match(g.fields.SEASON, /Indian winter/); assert.equal(g.fields.WEATHER, 'clear sky');
  assert.match(g.fields.DECOR_THEME, /no added theme/); assert.match(g.fields.COLOR_PALETTE, /ivory and gold chiavari chairs, cream \/ ivory sofas/);
  assert.match(build({ eventDate: '2026-08-01' }).fields.SEASON, /monsoon/); assert.match(build({ eventDate: '2026-04-01' }).fields.SEASON, /Indian summer/);
  assert.match(build({ country: 'AE', eventDate: '2026-07-01' }).fields.SEASON, /UAE summer/); assert.match(build({ country: 'US', eventDate: '2026-10-01' }).fields.SEASON, /autumn/);
  assert.match(build({ eventDate: '' }).fields.SEASON, /not specified/);
  assert.match(build({ camera: 'top' }).fields.CAMERA_ELEVATION, /90 deg/);
  assert.match(build({ camera: 'top', world: { w: 80, h: 140 } }).fields.ASPECT_RATIO, /2:3/);
  const e = build({ camera: 'eye' }).fields; assert.match(e.CAMERA_ELEVATION, /1\.6 m/); assert.match(e.FOCAL_LENGTH, /^35 mm/);
  assert.match(build({ quality: 'high' }).fields.IMAGE_QUALITY, /maximum detail/);
  assert.match(build({ weather: 'overcast' }).prompt, /Weather: overcast/);
  assert.match(build({ style: 'ballroom' }).fields.WEATHER, /indoor/);
  assert.match(build({ themeKey: 'royal' }).prompt, /Decor theme requested by the planner: royal Indian/);
});

t('outdoor never mentions ceiling / ballroom / walls; indoor gets its enclosure', () => {
  for (const style of ['golden', 'daylight', 'evening']) for (const camera of Object.keys(P.CAMERAS)) for (const themeKey of ['none', 'royal', 'pastel', 'minimal']) {
    const r = build({ style, camera, themeKey });
    assert.equal(r.environment, 'outdoor');
    assert.doesNotMatch(r.prompt, /ceiling|ballroom|interior|enclosed/i, style + '/' + camera + '/' + themeKey);
    assert.match(r.prompt, /Nothing overhead but sky/);
  }
  const b = build({ style: 'ballroom' }).prompt;
  assert.match(b, /Indoor: render a believable enclosed interior with its own ceiling, walls, flooring/); assert.match(b, /No sky, no gardens and no direct sunlight/);
});

t('canonical JSON embedded + parseable: every object id, correct facing, groups, seats, venue', () => {
  const r = build();
  const m = r.prompt.match(/CANONICAL EVENT JSON[^\n]*\n(\{[^\n]*\})\n/); assert.ok(m, 'json block');
  const J = JSON.parse(m[1]);
  assert.equal(J.venue.w, 200); assert.equal(J.venue.h, 140); assert.equal(J.venue.wm, 60.96); assert.match(J.venue.front, /top edge \(north\) - the stage/);
  assert.equal(J.venue.setting, 'outdoor');
  const ids = new Set(J.objects.map((o) => o.id));
  for (const it of OWNER) if (it.type !== 'exit') assert.ok(ids.has(it.id), it.id);
  assert.equal(J.objects.length, OWNER.length - 1);
  const sofa = J.objects.filter((o) => o.t === 'sofa'); assert.equal(sofa.length, 24);
  sofa.forEach((o) => { assert.equal(o.facing, 'faces stage (north)'); assert.equal(o.rot, 0); assert.equal(o.wm, 1.83); });
  const blocks = J.objects.filter((o) => o.t === 'seatblock');
  assert.deepEqual(blocks.map((b) => [b.rows, b.cols, b.seats, b.facing]), [[16, 25, 400, 'faces stage (north)'], [20, 25, 500, 'faces stage (north)']]);
  // left sofas in one group, right sofas in another (2 rows)
  const gOf = (x0) => new Set(sofa.filter((o) => (x0 < 100 ? o.x < 100 : o.x > 100)).map((o) => o.g));
  assert.equal(gOf(0).size, 1); assert.equal(gOf(200).size, 1); assert.notDeepEqual([...gOf(0)], [...gOf(200)]);
  assert.equal(J.objects.find((o) => o.t === 'stage').facing, 'faces guests (south)');
  assert.match(J.objects.find((o) => o.t === 'videowall').facing, /faces guests \(west\)/);
  // a rotated sofa keeps its own heading
  const rs = build({ items: OWNER.concat([I('sofa', 10, 70, 6, 3, {}, 180)]) });
  assert.equal(JSON.parse(rs.json).objects.find((o) => o.id === 'sofa-10-70').facing, 'faces south');
  assert.ok(r.json.length <= 12000, 'json ' + r.json.length);
});

t('object descriptions describe only the object itself (no stanchions / floral stands / LED walls added)', () => {
  const D = P.DESCRIPTIONS;
  assert.doesNotMatch(D.redcarpet, /floral|stanchion|stand|lined/i);
  assert.doesNotMatch(D.stage, /LED|floral|backdrop/i);
  assert.doesNotMatch(D.walkway, /floral|lined/i);
  assert.doesNotMatch(D.dj, /speaker/i); assert.doesNotMatch(D.bar, /stool/i); assert.doesNotMatch(D.foh, /canopy/i);
  const p = build().prompt;
  assert.doesNotMatch(p, /lined with tall floral stands|chrome stanchions|framed by lush floral installations/);
  for (const k of Object.keys(P.REGIONS)) assert.doesNotMatch(P.REGIONS[k].text, /diyas|urlis|string lights|palms|hanging floral strings/);
});

t('1,000-object layout: prompt within the limit, JSON compressed (never drops an object), FINAL OUTPUT kept', () => {
  const big = [I('stage', 300, 2, 60, 16), I('redcarpet', 327, 30, 6, 200)];
  for (let i = 0; i < 400; i++) big.push(I('chiavari', 20 + (i % 40) * 3, 40 + Math.floor(i / 40) * 4, 1.6, 1.6));
  for (let i = 0; i < 300; i++) big.push(I('sofa', 360 + (i % 30) * 7, 40 + Math.floor(i / 30) * 5, 6, 3));
  const types = ['table', 'floral', 'pillar', 'cocktail', 'uplight', 'planter', 'speaker', 'heater', 'barricade', 'ottoman'];
  for (let i = 0; i < 298; i++) big.push(I(types[i % 10], 10 + (i * 37) % 640, 150 + (i * 53) % 120, 4, 4));
  assert.equal(big.length, 1000);
  const r = P.build({ items: big, world: { w: 700, h: 280 }, eventType: 'Wedding', setting: 'outdoor', country: 'IN', style: 'golden' });
  assert.ok(r.prompt.length <= P.PROMPT_LIMIT, 'prompt ' + r.prompt.length);
  assert.ok(P.PROMPT_LIMIT <= 32000);
  assert.ok(r.jsonLevel >= 1);
  assert.match(r.prompt, /\nFINAL OUTPUT: ONE photorealistic[^\n]*$/);
  for (const s of SECTIONS) assert.ok(r.prompt.includes('\n' + s + '\n'), s);
  const J = JSON.parse(r.json);
  const total = J.objects.reduce((a, o) => a + (o.n || 1), 0);
  assert.equal(total, 1000, 'every object accounted for');
  // edge function keeps up to the same limit
  assert.match(rd('supabase/functions/render-photo/index.ts'), /String\(body\.prompt \|\| ""\)\.slice\(0, 30000\)/);
});

t('dialog: Weather option (Clear default) in plain words; passed to the prompt with quality + event date', () => {
  const html = rd('public/builder.html'), ui = rd('public/photo-render-ui.js');
  assert.match(html, /<label class="pfield">Weather\s*<select id="phWeather">\s*<option value="clear" selected>Clear<\/option>\s*<option value="partly">Partly cloudy<\/option>\s*<option value="overcast">Overcast<\/option>/);
  assert.match(ui, /weather: params\.weather, quality: params\.quality, eventDate: c\.eventDate/);
  assert.match(rd('public/builder.js'), /eventDate: PRICING\.eventDate \|\| ''/);
  assert.match(rd('public/capture.html'), /id="phWeather"/);
  assert.doesNotMatch(rd('public/photo-render-prompt.js'), /fetch\(|XMLHttpRequest|api\.openai/);
});


// ---- event-type profiles (owner: political renders must not look like a wedding) ----
const POL = [
  I('stage', 70, 3, 60, 16), I('podium', 97, 8, 6, 4), I('press', 90, 30, 20, 6), I('barricade', 20, 24, 160, 1), I('stagebarrier', 70, 20, 60, 1),
  I('linearray', 60, 4, 4, 4), I('linearray', 136, 4, 4, 4), I('led', 30, 2, 30, 1.5), I('led', 140, 2, 30, 1.5), I('flag', 10, 40, 2, 2), I('flag', 188, 40, 2, 2),
  I('seatblock', 30, 45, 60, 60, { rows: 20, cols: 30 }), I('seatblock', 110, 45, 60, 60, { rows: 20, cols: 30 }), I('redcarpet', 97, 45, 6, 80),
  I('generator', 185, 125, 10, 6), I('floralarch', 95, 128, 10, 2), I('table', 10, 120, 6, 6, { seats: 8 }),
];
const WEDDINGISH = /flower|floral|rose|marigold|mandap|couple|garland|petal|bridal|wedding/i;
const noForbidden = (p) => p.split('\n').filter((l) => !/FORBIDDEN/.test(l)).join('\n');
t('political rally: event type + profile up top, functional decor, no flower / wedding words anywhere outside the FORBIDDEN lists', () => {
  for (const eventType of ['Political rally', '']) for (const style of Object.keys(P.STYLES)) for (const camera of ['auto', 'eye']) for (const themeKey of ['none', 'pastel', 'royal', 'rally']) for (const country of ['IN', 'AE']) {
    const r = P.build({ items: POL, world: W, eventType, style, camera, themeKey, country, setting: 'outdoor' });
    assert.equal(r.profile, 'political', 'inferred: ' + eventType);
    assert.doesNotMatch(noForbidden(r.prompt), WEDDINGISH, [eventType, style, camera, themeKey].join('/') + ': ' + (noForbidden(r.prompt).match(WEDDINGISH) || [])[0]);
    assert.doesNotMatch(r.prompt, /Regional finish/);
    if (themeKey === 'pastel' || themeKey === 'royal') assert.doesNotMatch(r.prompt, /Decor theme requested/, 'incompatible theme ignored');
  }
  const p = P.build({ items: POL, world: W, eventType: 'Political rally', setting: 'outdoor' }).prompt;
  const iRole = p.indexOf('ROLE: '), iEv = p.indexOf('EVENT TYPE (decided first'), iS1 = p.indexOf('\n1. SOURCE-OF-TRUTH');
  assert.ok(iRole < iEv && iEv < iS1, 'event type right after ROLE / environment');
  assert.match(p, /EVENT TYPE \(decided first - style ONLY for this type\): Political rally \/ public meeting/);
  for (const re of [/plain-coloured flags and bunting \(no readable text, no symbols\)/, /steel crowd-control barricades/, /podium with a plain neutral front/, /press riser platform with video cameras on tripods/,
    /line-array/, /LED wall/, /truss lighting/, /generator tucked away/, /plain black \/ neutral skirting/, /a plain carpet runner laid flat/]) assert.match(p, re);
  const s6 = p.slice(p.indexOf('\n6. EVENT STYLING'), p.indexOf('\n7. LIGHTING')), s10 = p.slice(p.indexOf('\n10. FINAL VALIDATION'));
  assert.match(s6, /FORBIDDEN for this event type: flowers, florals, garlands or petals of any kind; floral arches or floral stands; wedding decor of any kind; couple \/ bridal chairs; chandeliers/);
  assert.match(s10, /FORBIDDEN check - none of these appear: flowers/);
  // object count is untouched: the floral arch object is still rendered (as a plain arch frame)
  assert.match(p, /1 floral arch|1 decor arch/i);
  assert.match(p, /a plain arch frame in neutral cloth/);
});

t('wedding still gets florals + regional decor; other types get their own profile', () => {
  const w = build();
  assert.equal(w.profile, 'wedding');
  assert.match(w.prompt, /florals/); assert.match(w.prompt, /Regional finish: Luxury Indian wedding decor finish[^\n]*marigold/);
  assert.match(build({ themeKey: 'pastel' }).prompt, /Decor theme requested by the planner: soft pastel florals/);
  assert.equal(build({ eventType: '' }).profile, 'wedding', 'owner layout inferred as a wedding');
  const corp = P.build({ items: [I('stage', 30, 2, 20, 8), I('podium', 38, 4, 3, 2), I('desk', 5, 40, 8, 3), I('brandwall', 2, 30, 1, 10), I('seatblock', 10, 20, 25, 20, { rows: 5, cols: 10 })], world: { w: 80, h: 50 }, eventType: '' });
  assert.equal(corp.profile, 'corporate'); assert.doesNotMatch(noForbidden(corp.prompt), WEDDINGISH); assert.match(corp.prompt, /branding wall with abstract graphics \(no readable text\)/);
  const expo = P.build({ items: Array.from({ length: 6 }, (_, i) => I('booth', 5 + i * 11, 5, 10, 10)), world: { w: 80, h: 50 } });
  assert.equal(expo.profile, 'exhibition'); assert.match(expo.prompt, /shell-scheme booths/);
  const gig = P.build({ items: [I('stage', 30, 2, 20, 8), I('linearray', 25, 2, 3, 3), I('foh', 38, 40, 6, 4), I('movinghead', 40, 3, 1, 1)], world: { w: 80, h: 50 } });
  assert.equal(gig.profile, 'concert'); assert.match(gig.prompt, /beams/); assert.doesNotMatch(noForbidden(gig.prompt), WEDDINGISH);
  assert.equal(P.profileKey('Birthday party', []), 'birthday'); assert.match(P.build({ items: POL.slice(0, 1), world: W, eventType: 'Birthday' }).prompt, /balloons and colourful accents allowed/);
  assert.equal(P.profileKey('Iftar dinner', []), 'iftar'); assert.equal(P.profileKey('', [I('majlis', 0, 0, 5, 5)]), 'iftar');
  assert.equal(P.profileKey('Sangeet', POL), 'wedding', 'the quote\'s event type wins over object evidence');
  assert.equal(P.profileKey('', [I('stage', 0, 0, 5, 5)]), 'wedding', 'no evidence: default look');
});

t('dialog: decor themes that do not fit the event type are hidden; None = the event type\'s own look', () => {
  const ui = rd('public/photo-render-ui.js');
  assert.match(ui, /function fitThemes\(c\)/); assert.match(ui, /fitThemes\(c\);/);
  const opts = ['none', 'royal', 'pastel', 'whitegreen', 'minimal', 'rustic', 'arabian', 'bollywood', 'corporate', 'rally', 'concert', 'other'].map((value) => ({ value, hidden: false, disabled: false }));
  const sel = { options: opts, value: 'pastel' };
  const fit = new Function('window', '$', 'c', ui.slice(ui.indexOf('function fitThemes'), ui.indexOf('  function open()')) + '; fitThemes(c);');
  fit({ HelmPhotoPrompt: P }, () => sel, { eventType: 'Political rally', items: POL });
  assert.equal(sel.value, 'none');
  assert.deepEqual(opts.filter((o) => !o.hidden).map((o) => o.value), ['none', 'minimal', 'corporate', 'rally', 'other']);
  assert.ok(opts.filter((o) => o.hidden).every((o) => o.disabled));
});
console.log(`render-master-prompt: ${n} checks passed`);
