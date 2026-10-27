// photo-render.test.mjs - 0095 photo-realistic renders: prompt builder over many layouts / event
// types / countries, dialog wiring, edge function dormant path, no API key in client code, CSP.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const rd = (p) => readFileSync(join(ROOT, p), 'utf8');
const P = createRequire(import.meta.url)('../public/photo-render-prompt.js');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('  ✓ ' + name); };

// ---- the owner's reference wedding (stage at the top, aisle down the middle) ----
const it = (type, x, y, width, height, properties) => ({ id: type + x + y, type, x, y, width, height, rotation: 0, properties: properties || {} });
const WEDDING = [
  it('stage', 80, 4, 40, 16), it('led', 92, 2, 16, 1.5), it('dj', 130, 8, 8, 5), it('dancefloor', 88, 24, 24, 24),
  it('seatblock', 50, 54, 40, 24, { rows: 10, cols: 16 }), it('seatblock', 110, 54, 40, 24, { rows: 10, cols: 16 }),
  it('sofa', 60, 50, 7, 3), it('sofa', 72, 50, 7, 3), it('sofa', 114, 50, 7, 3), it('sofa', 126, 50, 7, 3),
  it('redcarpet', 97, 50, 6, 70),
  it('floral', 94, 60, 2.5, 2.5), it('floral', 104, 60, 2.5, 2.5), it('floral', 94, 90, 2.5, 2.5), it('floral', 104, 90, 2.5, 2.5),
  it('barricade', 93, 70, 1, 30), it('barricade', 106, 70, 1, 30),
  it('fountain', 97, 124, 6, 6), it('floralarch', 95, 110, 10, 2), it('floralarch', 95, 100, 10, 2),
  it('buffet', 20, 132, 18, 3), it('buffet', 45, 132, 18, 3), it('buffet', 140, 132, 18, 3),
  it('caketable', 160, 30, 4, 4), it('restroom', 180, 120, 12, 8), it('fence', 0, 138, 200, 1), it('exit', 94, 134, 12, 6),
];
const W = { w: 200, h: 140 };

t('wedding prompt: every object type with its count + positions, aisle sides, seats', () => {
  const r = P.build({ items: WEDDING, world: W, eventType: 'Wedding', guests: 320, setting: 'outdoor', camera: 'hero', theme: 'royal gold & blush florals', country: 'IN' });
  const p = r.prompt;
  assert.match(p, /TOTALS BY TYPE: .*2 seating blocks \(20 rows, 320 chairs in total\)/);
  assert.match(p, /one seating block: 10 rows x 16 chairs per row = 160 chairs/);
  assert.match(p, /1 row of 2 sofas side by side .*LEFT of the aisle.*facing the stage/);
  assert.match(p, /4 sofas/);
  assert.match(p, /1 red carpet aisle/);
  assert.match(p, /4 floral stands/);
  assert.match(p, /seating block: 10 rows.*LEFT of the aisle/); assert.match(p, /seating block: 10 rows.*RIGHT of the aisle/);
  assert.match(p, /3 buffet lines/); assert.match(p, /1 row of 2 buffet lines side by side .*chafing dishes.* at the back-left/);
  assert.match(p, /1 fountain - .*at the back-centre/);
  assert.match(p, /2 floral arches/);
  assert.match(p, /1 stage - .*skirted front.*at the front-centre/); assert.doesNotMatch(p, /LED backdrop|lined with/);
  assert.match(p, /1 DJ booth .*LED/);
  assert.match(p, /checkered dance floor/);
  assert.match(p, /1 cake table/); assert.match(p, /1 restroom kiosk/); assert.match(p, /1 fence line/);
  assert.doesNotMatch(p, /exit pathway/);               // invisible zones are not "objects"
  assert.match(p, /stage is along the top edge/);
  assert.match(p, /about 320 guests/); assert.match(p, /200 ft \(61 m\) wide x 140 ft \(42\.7 m\) deep/);
  assert.match(p, /royal gold & blush florals/);
  assert.match(p, /marigold/);                          // India default
  assert.equal(r.style, 'golden'); assert.match(p, /golden-hour/);
  assert.match(p, /same position, height and angle as reference image 1/);
  assert.match(p, /^ENVIRONMENT \(mandatory/m); assert.match(p, /Reminder: open-air lawn at golden hour[^\n]*\nFINAL OUTPUT: [^\n]*$/);
  assert.ok(r.system.length > 200 && r.layout.length > 400 && p === r.system + '\n\n' + r.layout);
});

t('strict rules: keep layout, forbid text / labels / measurements / grid / watermarks', () => {
  const p = P.build({ items: WEDDING, world: W }).prompt;
  for (const re of [/EXACTLY as planned/, /same counts, same rows, same positions/, /merge or duplicate any object, row, group/i, /No text, letters, numbers, labels/, /measurement lines/, /grid lines/, /watermarks/, /Image 3: .* never draw any of it/, /not a 3D render/, /Photorealistic/])
    assert.match(p, re);
});

t('every ASSETS type in builder.js has a photographic description', () => {
  const src = rd('public/builder.js');
  const block = src.slice(src.indexOf('const ASSETS = {'), src.indexOf('};', src.indexOf('const ASSETS = {')));
  const keys = [...block.matchAll(/^\s*([a-z]+)\s*:\s*\{\s*label:/gm)].map((m) => m[1]);
  assert.ok(keys.length > 60, 'parsed ' + keys.length);
  const missing = keys.filter((k) => !P.DESCRIPTIONS[k] || P.DESCRIPTIONS[k].length < 12);
  assert.deepEqual(missing, []);
  // and a one-of-each layout mentions every visible type
  // (split in halves: one layout holding all 88+ distinct types overflows PROMPT_LIMIT by design)
  for (const part of [keys.filter((_, i) => i % 2 === 0), keys.filter((_, i) => i % 2 === 1)]) {
    const all = part.map((k, i) => it(k, (i * 7) % 190, (i * 11) % 130, 4, 4));
    const p = P.build({ items: all, world: W }).prompt;
    for (const k of part) if (!['exit', 'smoke', 'cableramp', 'distro'].includes(k)) assert.ok(p.includes(P.DESCRIPTIONS[k]), k);
  }
});

t('style mapping: defaults from venue setting + Evening toggle; explicit style wins', () => {
  assert.equal(P.defaultStyle('outdoor', false), 'golden');
  assert.equal(P.defaultStyle('indoor', false), 'ballroom');
  assert.equal(P.defaultStyle('outdoor', true), 'evening');
  assert.equal(P.defaultStyle('indoor', true), 'evening');
  assert.equal(P.build({ items: WEDDING, world: W, setting: 'indoor' }).style, 'ballroom');
  assert.equal(P.build({ items: WEDDING, world: W, setting: 'outdoor', evening: true }).style, 'evening');
  const d = P.build({ items: WEDDING, world: W, style: 'daylight', evening: true });
  assert.equal(d.style, 'daylight'); assert.match(d.prompt, /midday daylight/);
  assert.match(P.build({ items: WEDDING, world: W, style: 'ballroom' }).prompt, /chandeliers/);
  assert.match(P.build({ items: WEDDING, world: W, setting: 'indoor' }).prompt, /indoor event space/);
});

t('cameras: hero / top-down / eye-level from the entrance', () => {
  assert.match(P.build({ items: WEDDING, world: W, camera: 'top' }).prompt, /Straight-down aerial/);
  assert.match(P.build({ items: WEDDING, world: W, camera: 'eye' }).prompt, /Eye-level photograph from the guest entrance/);
  assert.equal(P.build({ items: WEDDING, world: W, camera: 'nope' }).camera, 'auto');
});

t('regions: India default, Dubai luxury for UAE, US styling for US', () => {
  assert.match(P.build({ items: WEDDING, world: W, country: 'AE' }).prompt, /Dubai luxury/);
  assert.match(P.build({ items: WEDDING, world: W, country: 'US' }).prompt, /Upscale American/);
  assert.match(P.build({ items: WEDDING, world: W, country: '' }).prompt, /Indian wedding decor/);
  assert.match(P.build({ items: WEDDING, world: W, country: 'GB' }).prompt, /Indian wedding decor/);
});

t('orientation: stage on each edge -> front/left/right relative to the guests', () => {
  const lay = (stage, buffet) => P.build({ items: [it('stage', ...stage), it('buffet', ...buffet)], world: { w: 100, h: 100 } });
  // stage at bottom, buffet top-left of the plan = back-right for guests facing the stage
  let r = lay([30, 88, 40, 10], [2, 2, 18, 3]);
  assert.equal(r.stats.orientation, 'bottom'); assert.match(r.prompt, /buffet line .*at the back-right/);
  r = lay([0, 30, 10, 40], [80, 2, 18, 3]);           // stage left, buffet top-right of plan = back-right
  assert.equal(r.stats.orientation, 'left'); assert.match(r.prompt, /buffet line .*at the back-right/);
  r = lay([90, 30, 10, 40], [80, 2, 18, 3]);          // stage right, buffet top-right = front-left
  assert.equal(r.stats.orientation, 'right'); assert.match(r.prompt, /buffet line .*at the front-left/);
  r = P.build({ items: [it('buffet', 2, 2, 18, 3)], world: { w: 100, h: 100 } });
  assert.match(r.prompt, /There is no stage/);
});

t('many event types / layouts: robust, bounded, never echoes unsafe text', () => {
  const types = ['wedding', 'Reception', 'Sangeet', 'Corporate conference', 'Concert', 'Birthday', 'Expo', '<script>x</script>'];
  for (const ev of types) for (const c of ['IN', 'AE', 'US']) for (const cam of ['hero', 'top', 'eye']) {
    const r = P.build({ items: WEDDING.concat([it('table', 10, 10, 6, 6, { seats: 8 }), it('mandap', 150, 60, 16, 16)]), world: W, eventType: ev, country: c, camera: cam, theme: 'gold {x} `y` <b>' });
    assert.ok(r.prompt.length < 30001);
    assert.doesNotMatch(r.prompt.replace(r.json, ''), /[<>{}`]/); assert.doesNotMatch(r.json, /[<>`]|gold \{x/);
    assert.match(r.prompt, /1 round banquet table .*8 seats in total/);
    assert.match(r.prompt, P.PROFILES[r.profile].florals ? /1 mandap/ : /1 ceremony stage/);   // non-celebration types never say mandap
  }
  assert.match(P.build({}).prompt, /empty floor/);
  assert.match(P.build({ items: [it('chiavari', 5, 5, 1.6, 1.6), it('chiavari', 9, 5, 1.6, 1.6)], world: W }).prompt, /2 chiavari chairs/);
});

// ---- dialog wiring ----
const html = rd('public/builder.html'), ui = rd('public/photo-render-ui.js'), cap = rd('public/capture.html');
t('builder: Render dialog markup with style / camera / theme / quality / count, progress, cancel, gallery, history', () => {
  for (const id of ['photoModal', 'phStyle', 'phCamera', 'phTheme', 'phQuality', 'phCount', 'phProgress', 'phCancel', 'phGallery', 'phAgain', 'phHistList', 'photoSetup'])
    assert.match(html, new RegExp('id="' + id + '"'), id);
  for (const v of ['golden', 'evening', 'daylight', 'ballroom', 'auto', 'current', 'top', 'eye', 'standard', 'high']) assert.match(html, new RegExp('value="' + v + '"'));
  assert.match(html, /<option value="4">4<\/option>/);
  assert.match(html, /Photo renders aren’t switched on for your studio yet\./);
  assert.doesNotMatch(html, /OPENAI_API_KEY/);
  assert.match(html, /builder-3d\.js\?v=26"><\/script>\n<script src="photo-render-prompt\.js\?v=8"><\/script>\n<script src="photo-render-ui\.js\?v=9"><\/script>/);
  assert.match(cap, /photo-render-ui\.js\?v=9/);
  assert.doesNotMatch(html, /style="/);
});
t('dialog: three captures (clean 3D labels none, plan plain, plan names + measure), ≤1536 px, render via BPStore', () => {
  assert.match(ui, /MAX_W = 1536/);
  assert.match(ui, /__capture3D\(MAX_W, cameraOpts\(params\.camera, c, params\.focus\)\)/);
  assert.match(ui, /planBlob\(\{ clean: true, maxW: MAX_W, labels: 'none' \}\)/);
  assert.match(ui, /planBlob\(\{ clean: true, maxW: MAX_W, labels: 'names', measure: true \}\)/);
  assert.match(ui, /var o = \{ labels: 'none' \}/);
  assert.match(ui, /P\.cameraView\(kind, c\.items, c\.world/);
  assert.match(ui, /__helm3D; if \(h && h\.isActive && h\.isActive\(\) && h\.getView\)/);
  assert.match(ui, /A\.render\(/); assert.match(ui, /useInBooklet/); assert.match(ui, /api\(\)\.list\(/);
  assert.match(ui, /AbortController/); assert.match(ui, /render_not_configured/);
  assert.doesNotMatch(ui, /innerHTML/);
  const b = rd('public/builder.js');
  assert.match(b, /window\.__helmPhotoCtx = function/);
  assert.match(b, /showMeasure=!!o\.measure/);
  assert.match(rd('public/builder-3d.js'), /opts\.view && Array\.isArray\(opts\.view\.pos\)/);
});
t('store-api: render goes to the render-photo edge function only; area + RPCs', () => {
  const s = rd('public/store-api.js');
  assert.match(s, /fnUrl\("render-photo"\)/);
  assert.match(s, /key: "photo_render"/);
  for (const r of ['photo_render_list', 'photo_render_image', 'photo_render_use_in_booklet', 'photo_render_settings_get', 'photo_render_settings_set']) assert.match(s, new RegExp('"' + r + '"'));
  assert.match(rd('public/control.html'), /id="prCard"/);
  assert.match(rd('public/control.html'), /photo-render-settings\.js\?v=2/);
});

// ---- no key in client code; OpenAI only server-side ----
t('no OpenAI key or OpenAI host anywhere in public/; CSP connect-src has the Supabase functions origin only', () => {
  const walk = (d) => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
  for (const f of walk(join(ROOT, 'public')).filter((p) => /\.(js|html|json|txt)$/.test(p))) {
    const s = readFileSync(f, 'utf8');
    assert.doesNotMatch(s, /api\.openai\.com/, f);
    assert.doesNotMatch(s, /sk-[A-Za-z0-9_-]{20,}/, f);
    assert.doesNotMatch(s, /OPENAI_API_KEY\s*[:=]\s*["'][^"']/, f);
  }
  const hdr = rd('public/_headers'); const vj = rd('vercel.json');
  assert.doesNotMatch(hdr, /openai/i); assert.doesNotMatch(vj, /openai/i);
  const cs = hdr.match(/connect-src[^;]*/g) || [];
  assert.ok(cs.length && cs.every((c) => /https:\/\/nqltzgiwznphugcfhmbm\.supabase\.co/.test(c)));
});

// ---- edge function (static; runtime cases in tests/edge/render-photo.test.ts) ----
const fn = rd('supabase/functions/render-photo/index.ts');
t('render-photo: dormant 503 render_not_configured before anything else; key from Deno.env only', () => {
  assert.match(fn, /if \(notConfigured\(\)\) return json\(\{ error: "render_not_configured" \}, 503\)/);
  assert.ok(fn.indexOf('notConfigured()) return') < fn.indexOf('checkLimits('));
  assert.match(fn, /Deno\.env\.get\("OPENAI_API_KEY"\)/);
  assert.match(fn, /https:\/\/api\.openai\.com\/v1\/images\/edits/);
  assert.match(fn, /fd\.append\("image\[\]"/);
  assert.match(fn, /"gpt-image-2\.5-sunburst"/);
  // async: answer 202 with the job, finish in the background, browser polls photo_render_job
  assert.match(fn, /ER\.waitUntil\(work\(\)\)/);
  assert.match(fn, /job_id: usageId, status: "pending"/);
  assert.match(fn, /\|\| 140_000/);
  const sa = rd('public/store-api.js');
  assert.match(sa, /rpc\("photo_render_job", \{ p_usage_id: j\.job_id \}\)/);
  assert.match(sa, /res\.status !== 202/);
  // booklet: the photo is its own picture kind, shown in the 3D section
  assert.match(rd('supabase/migrations/0095_photo_render.sql'), /'photo', 'plain', r\.mime/);
  assert.match(rd('public/booklet.js'), /B\.publicImage\(d\.__token, "photo", "plain"\)/);
  assert.match(rd('supabase/functions/README.md'), /supabase functions deploy render-photo/);
  assert.match(fn, /asCaller\.rpc\("photo_render_begin"/);
  assert.match(fn, /AbortController/);
  assert.match(fn, /BODY_LIMIT = 11 \* 1024 \* 1024/);
  assert.match(rd('docs/PHOTO-RENDER-SETUP.md'), /supabase secrets set OPENAI_API_KEY=/);
});

// ---- SQL ----
t('0095: additive, RLS on, definer + empty search_path, MANIFEST + run-all', () => {
  const sql = rd('supabase/migrations/0095_photo_render.sql');
  assert.doesNotMatch(sql, /\bdrop (table|column)\b|\btruncate\b|\bdelete from\b/i);
  assert.equal((sql.match(/create or replace function/g) || []).length, (sql.match(/security definer set search_path = ''/g) || []).length);
  assert.match(sql, /enable row level security/);
  assert.match(rd('supabase/migrations/MANIFEST'), /forward  supabase\/migrations\/0095_photo_render\.sql/);
  assert.match(rd('scripts/db-test/run-all.sh'), /photo-render-0095/);
});

t('not-deployed render-photo (fetch TypeError / 404) shows the setup card, not nothing', () => {
  assert.match(ui, /code === 'render_not_configured' \|\| code === 'render_disabled' \|\| isNetErr\(e\)\) showOff\(OFF_MSG, canManage\(\)\)/);
  assert.match(ui, /failed to fetch/i);
  assert.match(ui, /api\(\)\.probe\(\)/);
  const api = rd('public/store-api.js');
  assert.match(api, /probe: \(\) => \{/); assert.match(api, /method: "OPTIONS"/);
  assert.match(api, /res\.status === 404 && !j\.error\) \{ const e = new Error\("Photo renders aren't switched on yet\."\); e\.code = "render_not_configured"/);
  assert.match(api, /e\.code = "render_not_configured"; e\.cause = fe; throw e;/);
  assert.match(html, /Contact Helm support to switch them on\./);
});
console.log('\nphoto-render: ' + n + ' passed.');
