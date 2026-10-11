// render-fidelity.test.mjs - photo render fidelity: exact inventory (groups / rows / counts) on the owner's
// wedding layout, strong distinct environment per style, 4th reference image (semantic colour map),
// payload limits, and the dialog passing the chosen style + 4 images. NO real network: fetch is stubbed to throw.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const rd = (p) => readFileSync(join(ROOT, p), 'utf8');
globalThis.fetch = () => { throw new Error('network is not allowed in this test'); };
const P = createRequire(import.meta.url)('../public/photo-render-prompt.js');
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('  ✓ ' + name); };

// ---- the owner's real wedding: 200 x 140 ft lawn, stage at the top, aisle down the centre turning right ----
const I = (type, x, y, width, height, properties, rotation) => ({ id: type + '-' + x + '-' + y, type, x, y, width, height, rotation: rotation || 0, properties: properties || {} });
const sofas = (x0, y, k) => Array.from({ length: k }, (_, i) => I('sofa', x0 + i * 6.5, y, 6, 3, { seats: 3 }));
const OWNER = [
  I('stage', 75, 3, 50, 16), I('led', 85, 1, 30, 1.5), I('dj', 20, 10, 8, 5), I('led', 18, 2, 14, 1.5),
  I('dancefloor', 88, 22, 24, 16),
  I('seatblock', 44, 50, 50, 48, { rows: 16, cols: 25 }), I('seatblock', 106, 50, 50, 60, { rows: 20, cols: 25 }),
  ...sofas(43, 45, 8),                                 // LEFT: one row of 8 sofas in front of the left block
  ...sofas(105, 40.5, 8), ...sofas(105, 45, 8),        // RIGHT: two rows of 8 sofas in front of the right block
  I('redcarpet', 97, 40, 6, 80), I('redcarpet', 103, 114, 97, 6),
  I('floralarch', 130, 112, 2, 10), I('floralarch', 145, 112, 2, 10), I('floralarch', 160, 112, 2, 10), I('floralarch', 175, 112, 2, 10),
  I('fountain', 185, 95, 8, 8), I('videowall', 192, 45, 2, 24),
  ...[20, 45, 70, 105, 130, 155].map((x) => I('buffet', x, 132, 18, 3)),
  I('fence', 0, 138, 200, 1), I('caketable', 160, 26, 5, 5), I('restroom', 4, 110, 12, 8), I('exit', 186, 126, 12, 6),
];
const W = { w: 200, h: 140 };
const build = (o) => P.build(Object.assign({ items: OWNER, world: W, eventType: 'Wedding', setting: 'outdoor', country: 'IN' }, o || {}));

await t('owner layout: sofas stay 1 row LEFT and 2 rows RIGHT, never merged', () => {
  const r = build(), p = r.prompt;
  assert.match(p, /: 1 row of 8 sofas side by side - [^\n]*LEFT of the aisle, directly in front of \(stage side of\) the left seating block/);
  assert.match(p, /: 2 rows x 8 sofas = 16 sofas \(2 rows, one behind the other\) - [^\n]*RIGHT of the aisle, directly in front of \(stage side of\) the right seating block/);
  assert.match(p, /- G\d+ left sofa group: 1 row, 8 sofas\n/);
  assert.match(p, /- G\d+ right sofa group: 2 rows, 16 sofas\n/);
  const sg = r.stats.groups.filter((g) => g.type === 'sofa');
  assert.deepEqual(sg.map((g) => g.count).sort((a, b) => a - b), [8, 16]);
  assert.deepEqual(sg.find((g) => g.count === 16).rows, [8, 8]);
  assert.match(p, /TOTALS BY TYPE: .*24 sofas/);
});

await t('owner layout: seat blocks as rows x chairs per row with exact totals', () => {
  const p = build().prompt;
  assert.match(p, /one seating block: 16 rows x 25 chairs per row = 400 chairs - [^\n]*LEFT of the aisle/);
  assert.match(p, /one seating block: 20 rows x 25 chairs per row = 500 chairs - [^\n]*RIGHT of the aisle/);
  assert.match(p, /left seating block: 16 rows, 400 chairs/); assert.match(p, /right seating block: 20 rows, 500 chairs/);
  assert.match(p, /2 seating blocks \(36 rows, 900 chairs in total\)/);
  assert.match(p, /\(972 seats on the plan\)/);
});

await t('owner layout: arches, buffets, screens, singles - exact counts + checklist + verify instruction', () => {
  const r = build(), p = r.prompt;
  assert.match(p, /1 row of 4 floral arches side by side/);
  assert.match(p, /1 row of 6 buffet lines side by side - [^\n]*along the back edge of the venue/);
  assert.match(p, /2 LED walls/); assert.match(p, /1 LED video wall/); assert.match(p, /1 fountain/); assert.match(p, /1 cake table/);
  assert.match(p, /1 restroom kiosk/); assert.match(p, /2 red carpet aisles/);
  assert.match(p, /COUNT CHECKLIST \(exact numbers - \d+ groups\):/);
  assert.match(p, /Before finalising, verify every count, every row and every group in the checklist against Image 2 and Image 4/);
  assert.match(p, /Two separate groups stay two separate groups/);
  assert.doesNotMatch(p, /exit pathway/);
  // every group in the inventory has a checklist line
  const inv = (p.match(/^- G\d+: /gm) || []).length, chk = (p.match(/^- G\d+ [^:]+: /gm) || []).length;
  assert.equal(inv, r.stats.groups.length); assert.equal(chk, inv);
});

await t('image roles: 4 images described precisely, colour key in the prompt', () => {
  const p = build().prompt;
  assert.match(p, /Image 1: camera \/ composition reference .* Match its viewpoint/);
  assert.match(p, /Image 2: top-down 2D floor plan without labels/);
  assert.match(p, /Image 3: the same plan with labels and measurements - use it ONLY to identify objects and read their sizes \/ scale/);
  assert.match(p, /Image 4: colour-coded semantic map .*teal = chairs.*magenta = sofas.*blue = stage/);
  assert.match(p, /Never reproduce these flat colours/);
  assert.doesNotMatch(build({ images: 3 }).prompt, /Image 4/);
});

const ENV_OF = (p) => p.split('\n')[0];
await t('styles: environment block first, strong and clearly different; reminder at the very end', () => {
  const g = build({ style: 'golden' }), e = build({ style: 'evening' }), d = build({ style: 'daylight' }), b = build({ style: 'ballroom' });
  for (const r of [g, e, d, b]) { assert.match(r.prompt, /^ENVIRONMENT \(mandatory/); assert.match(r.prompt.split('\n').pop(), /^Reminder: /); }
  assert.match(ENV_OF(g.prompt), /OPEN-AIR.*sun is LOW.*LONG shadow.*trees/i);
  assert.match(ENV_OF(e.prompt), /blue hour.*festoon string lights.*uplights/);
  assert.match(ENV_OF(d.prompt), /bright midday.*neutral white balance/);
  assert.match(ENV_OF(b.prompt), /INDOOR ballroom.*ceiling.*chandeliers.*drapes.*carpet/);
  // pairwise word overlap of the environment blocks stays low (they really differ)
  const words = (s) => new Set(s.replace(/^.*?\): /, "").toLowerCase().match(/[a-z]{4,}/g));
  const envs = [g, e, d, b].map((r) => words(ENV_OF(r.prompt)));
  for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) {
    const A = envs[i], B = envs[j], inter = [...A].filter((w) => B.has(w)).length;
    assert.ok(inter / Math.min(A.size, B.size) < 0.5, 'env ' + i + ' vs ' + j + ' too similar');
  }
});

await t('outdoor styles never mention ceiling / walls / carpet / ballroom in the environment, venue line or reminder', () => {
  for (const style of ['golden', 'daylight', 'evening']) for (const setting of ['outdoor', 'indoor']) {
    const r = build({ style, setting });
    if (style === 'evening' && setting === 'indoor') continue;          // evening follows the venue: dim ballroom
    assert.equal(r.environment, 'outdoor', style + '/' + setting);
    const envText = [ENV_OF(r.prompt), r.prompt.split('\n').pop(), (r.prompt.match(/^VENUE: .*$/m) || [''])[0]].join(' ');
    assert.doesNotMatch(envText, /ceiling|walls?\b|carpet|ballroom|chandelier|indoor/i, style + '/' + setting);
  }
  const ei = build({ style: 'evening', setting: 'indoor' });
  assert.equal(ei.environment, 'indoor'); assert.match(ENV_OF(ei.prompt), /INDOOR ballroom in the evening.*chandeliers/);
  assert.equal(build({ style: 'ballroom', setting: 'outdoor' }).environment, 'indoor', 'the user\'s choice wins');
  assert.equal(build({ style: 'golden', setting: 'indoor' }).environment, 'outdoor', 'outdoor style on an indoor venue follows the user');
});

await t('default style follows the venue setting + Evening toggle; unknown setting is inferred', () => {
  assert.equal(P.defaultStyle('outdoor', false), 'golden'); assert.equal(P.defaultStyle('indoor', false), 'ballroom');
  assert.equal(P.defaultStyle('outdoor', true), 'evening'); assert.equal(P.defaultStyle(undefined, false, OWNER), 'golden');
  assert.equal(P.defaultStyle(null, false, [I('stage', 0, 0, 10, 10)]), 'ballroom');
  assert.equal(build({ style: undefined }).style, 'golden'); assert.equal(build({ style: undefined, evening: true }).style, 'evening');
});

await t('rules kept: no text / labels / watermarks / grid / measurement lines; theme None adds nothing', () => {
  const p = build({ themeKey: 'none' }).prompt;
  for (const re of [/No text, letters, numbers, labels/, /watermarks/, /measurement lines/, /grid lines/, /colour-coded patches/, /EXACTLY as planned/]) assert.match(p, re);
  assert.doesNotMatch(p, /Decor theme requested/);
  assert.match(build({ themeKey: 'royal' }).prompt, /Decor theme requested by the planner: royal Indian/);
  assert.ok(p.length < 30001);
});

await t('semantic map: one distinct flat colour per category, legend, white ground, floor items underneath', () => {
  const m = P.semanticMap(OWNER, W);
  assert.equal(m.background, '#FFFFFF');
  assert.equal(m.shapes.length, OWNER.filter((i) => i.type !== 'exit').length);
  const colOf = (type) => new Set(m.shapes.filter((s) => s.type === type).map((s) => s.color));
  assert.deepEqual([...colOf('sofa')], ['#E6007E']); assert.deepEqual([...colOf('seatblock')], ['#00A6A6']); assert.deepEqual([...colOf('stage')], ['#1F3FFF']);
  const cols = P.CATEGORIES.map((c) => c.color);
  assert.equal(new Set(cols).size, cols.length, 'every category has its own colour');
  assert.ok(!cols.includes('#FFFFFF'));
  const byCat = {}; m.shapes.forEach((s) => { (byCat[s.cat] ||= new Set()).add(s.color); });
  Object.values(byCat).forEach((s) => assert.equal(s.size, 1));
  assert.equal(new Set(m.legend.map((l) => l.color)).size, m.legend.length);
  assert.equal(m.shapes[0].z, 0); assert.ok(m.shapes.findIndex((s) => s.type === 'redcarpet') < m.shapes.findIndex((s) => s.type === 'sofa'));
});

// ---- dialog: draws the semantic map, sends 4 images + the chosen style (all stubbed) ----
await t('dialog: 4 reference images (each <= 1536 px JPEG 0.85), chosen style passed through, no network', async () => {
  const els = {}; const el = (id) => ({ id, hidden: false, value: '', textContent: '', className: '', disabled: false, children: [],
    addEventListener() {}, replaceChildren() {}, appendChild(c) { this.children.push(c); }, querySelectorAll: () => [], focus() {}, remove() {} });
  const $ = (id) => (els[id] ||= el(id));
  $('photoForm').addEventListener = function (ev, fn) { if (ev === 'submit') this.submit = fn; };
  const fills = [];
  const canvas = () => ({ width: 0, height: 0, getContext: () => ({ set fillStyle(v) { fills.push(v); }, get fillStyle() { return ''; }, fillRect() {}, strokeRect() {}, save() {}, restore() {}, translate() {}, rotate() {}, strokeStyle: '', lineWidth: 1 }),
    toBlob(cb) { cb({ size: 10, kind: 'semantic', w: this.width, h: this.height }); } });
  const sent = [], enc = [];
  const win = { HelmPhotoPrompt: P, BPUI: { toast() {} },
    BPStore: { booklet: { encodeImage: async (b, w, q) => { enc.push([b, w, q]); return { mime: 'image/jpeg', data: 'AAAA' }; } },
      photoRender: { available: () => true, settings: async () => ({ enabled: true, can_render: true }), list: async () => [],
        render: async (body) => { sent.push(body); return { renders: [] }; } } },
    __capture3D: async () => ({ kind: '3d' }),
    __helmPhotoCtx: () => ({ quoteId: 'q1', supported: true, items: OWNER, world: W, setting: 'indoor', planBlob: async (o) => ({ kind: o.measure ? 'plan-m' : 'plan' }) }) };
  const doc = { readyState: 'complete', getElementById: $, createElement: (tag) => tag === 'canvas' ? canvas() : el(tag), querySelector: () => null, addEventListener() {} };
  vm.runInNewContext(rd('public/photo-render-ui.js'), Object.assign({ window: win, document: doc, setTimeout, clearTimeout, Promise, Date, AbortController, console, fetch: globalThis.fetch }, win));
  const UI = win.HelmPhotoRenderUI;
  const sem = await UI.drawSemantic(OWNER, W, 1536);
  assert.equal(sem.w, 1536); assert.ok(sem.h <= 1536);
  for (const c of ['#E6007E', '#00A6A6', '#1F3FFF', '#FFFFFF']) assert.ok(fills.includes(c), c);
  // full run with the "Golden hour" style on a venue saved as indoor -> the user's choice wins
  $('phStyle').value = 'golden'; $('phCamera').value = 'auto'; $('phThemeSel').value = 'none'; $('phFocus').value = ''; $('phQuality').value = 'standard'; $('phCount').value = '1';
  assert.equal(UI.readForm().style, 'golden');
  els.photoForm.submit({ preventDefault() {} });
  for (let i = 0; i < 50 && !sent.length; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(sent.length, 1);
  const body = sent[0];
  assert.equal(body.images.length, 4);
  assert.equal(body.style, 'golden');
  assert.match(body.prompt, /^ENVIRONMENT \(mandatory[^\n]*OPEN-AIR/);
  assert.match(body.prompt, /Image 4: colour-coded semantic map/);
  assert.equal(enc.length, 4); enc.forEach(([, w, q]) => { assert.equal(w, 1536); assert.equal(q, 0.85); });
  assert.equal(enc[3][0].kind, 'semantic');
});

await t('payload limits: edge function accepts up to 4 pictures <= 2 MB each, body cap fits them', () => {
  const fn = rd('supabase/functions/render-photo/index.ts');
  assert.match(fn, /const MAX_IMAGES = 4;/);
  assert.match(fn, /imgs\.length > MAX_IMAGES/);
  const img = Number(fn.match(/IMG_LIMIT = (\d+) \* 1024 \* 1024/)[1]) * 1048576, body = Number(fn.match(/BODY_LIMIT = (\d+) \* 1024 \* 1024/)[1]) * 1048576;
  assert.equal(img, 2 * 1048576);
  assert.ok(body >= 4 * Math.ceil(img * 4 / 3) + 40000, 'body cap holds 4 max-size base64 pictures + prompt');
  assert.ok(body <= 12 * 1048576);
  const ui = rd('public/photo-render-ui.js');
  assert.match(ui, /var MAX_W = 1536;/); assert.match(ui, /encodeImage\(blob, MAX_W, 0\.85\)/);
  assert.doesNotMatch(rd('public/photo-render-prompt.js'), /fetch\(|XMLHttpRequest|api\.openai/);
  assert.doesNotMatch(ui, /api\.openai|OPENAI/);
});

console.log(`render-fidelity: ${n} checks passed`);
