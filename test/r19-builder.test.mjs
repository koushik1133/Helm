// Builder round 19 (fix/r19-builder):
//   1  2D paint order = the 3D one: floor coverings (carpet / aisle runner / dance floor / walkway / parking, or any piece
//      spread over half the hall) are drawn first, so a full-hall "Carpet / Aisle" no longer hides the stage, screens,
//      truss and pillars at the top of the hall (the 3D view always laid it flat on the floor). No mirroring: 2D x -> 3D x,
//      2D y -> 3D z (top of the plan = far side of the 3D hall), 2D clockwise rotation = 3D -rotation about y.
//   2  the zoom / pan / fullscreen / tour controls sit in a dock UNDER the plan (never over the hall), the pan arrows open on
//      demand, the dock folds away to one button; semi-transparent until hovered
//   3  free trial: the separate "Reference a past layout" dropdown is hidden (past events are under "Start blank...")
//   4  the header: two fixed rows of whole groups (this layout / the canvas); 3D-only camera presets only in 3D
//   5  a first-run mini tour of every toolbar control in screen order (tour.js), once per browser
//   6  0213: real floor plans for the five sample events that opened on an empty floor
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0; const t = (name, fn) => { try { fn(); n++; } catch (e) { console.error('FAIL', name); throw e; } };

const T = require('../public/builder-tools.js');
const js = read('public/builder.js'), html = read('public/builder.html'), css = read('public/builder.css');
const head = (html.match(/<header[\s\S]*?<\/header>/) || [''])[0];

/* ---------------- 1) draw order ---------------- */
t('drawOrder: a full-hall carpet added after the stage is painted first; everything else keeps its order', () => {
  // the corporate round-tables gala (SMP-1003): stage + screens + truss at the top, a 170 x 150 "Carpet / Aisle" later in the list
  const items = [
    { id: 'truss', type: 'lighting', x: 59.5, y: 4, width: 51, height: 1.5 },
    { id: 'stage', type: 'stage', x: 59.5, y: 7, width: 51, height: 20 },
    { id: 'ledL', type: 'led', x: 34, y: 10, width: 17, height: 1.5, rotation: 330 },
    { id: 'pillar', type: 'pillar', x: 51.1, y: 3.5, width: 1.8, height: 5 },
    { id: 'carpet', type: 'redcarpet', x: 0, y: 0, width: 170, height: 150 },
    { id: 't1', type: 'table', x: 27.6, y: 42.1, width: 12, height: 12 },
  ];
  const before = JSON.stringify(items);
  const o = T.drawOrder(items, { w: 170, h: 150 }).map((i) => i.id);
  assert.deepEqual(o, ['carpet', 'truss', 'stage', 'ledL', 'pillar', 't1']);
  assert.equal(JSON.stringify(items), before, 'never mutates the saved order');
});
t('drawOrder: floor pieces lie under the rest, the biggest first (a dance floor on a full carpet still shows)', () => {
  const items = [
    { id: 'df', type: 'dancefloor', x: 40, y: 20, width: 24, height: 24 },
    { id: 'chair', type: 'chiavari', x: 1, y: 1, width: 1.6, height: 1.6 },
    { id: 'rug', type: 'redcarpet', x: 0, y: 0, width: 200, height: 140 },
    { id: 'aisle', type: 'redcarpet', x: 98, y: 50, width: 4, height: 80 },
    { id: 'tent', type: 'tent', x: 0, y: 0, width: 150, height: 120 },   // a piece over half the hall counts as floor too
    { id: 'stage', type: 'stage', x: 80, y: 2, width: 40, height: 16 },
  ];
  assert.deepEqual(T.drawOrder(items, { w: 200, h: 140 }).map((i) => i.id), ['rug', 'tent', 'df', 'aisle', 'chair', 'stage']);
  assert.equal(T.isFloorCover({ type: 'stage', width: 40, height: 16 }, { w: 200, h: 140 }), false);
  assert.equal(T.isFloorCover({ type: 'walkway', width: 6, height: 24 }, { w: 200, h: 140 }), true);
  assert.equal(T.isFloorCover(null, { w: 200, h: 140 }), false);
  const plain = [{ id: 'a', type: 'stage' }, { id: 'b', type: 'table' }];
  assert.deepEqual(T.drawOrder(plain, { w: 200, h: 140 }).map((i) => i.id), ['a', 'b']);
  assert.deepEqual(T.drawOrder(undefined), []);
});
t('the 2D canvas, the version thumbnails and the PNG / client capture (renderAll) all paint in that order', () => {
  assert.match(js, /function drawOrder2D\(items, world\)\{ const T=window\.HelmBuilderTools; return \(T && T\.drawOrder\) \? T\.drawOrder\(items, world\|\|WORLD\) : items\.slice\(\); \}/);
  assert.match(js, /drawOrder2D\(store\.items\)\.forEach\(it=> svg\.appendChild\(renderItem\(it\)\)\)/, 'renderAll');
  assert.match(js, /drawOrder2D\(store\.items\)\.forEach\(it=>svg\.appendChild\(renderItem\(it\)\)\);\n  renderMargins\(\);\n  appendSelectionOverlays\(\);/, 'renderSceneOnly');
  assert.match(js, /drawOrder2D\(items, \{w, h\}\)\.forEach\(it=>\{/, 'version thumbnail');
  assert.ok(!/store\.items\.forEach\(it=> ?svg\.appendChild\(renderItem/.test(js), 'no array-order painting left');
});
t('2D is not mirrored against 3D (same axes and turning direction)', () => {
  const b3 = read('public/builder-3d.js');
  assert.match(b3, /const sx = fx => fx - WORLD\.w\/2;/); assert.match(b3, /const sz = fy => fy - WORLD\.h\/2;/);
  assert.match(b3, /g\.position\.set\(sx\(it\.x\+it\.width\/2\),0,sz\(it\.y\+it\.height\/2\)\); g\.rotation\.y=-\(it\.rotation\|\|0\)\*Math\.PI\/180;/);
});

/* ---------------- 2) the view dock ---------------- */
t('view controls: docked under the plan, pan arrows on demand, the dock folds away; choices remembered safely', () => {
  assert.match(html, /<div class="fabstack" id="fabStack" role="toolbar" aria-label="View controls">/);
  assert.match(html, /<div class="navpad" id="navPad" role="group" aria-label="Pan the view" hidden>/);
  assert.match(html, /id="navPadToggle" aria-controls="navPad" aria-expanded="false"/);
  assert.match(html, /id="dockHide" aria-label="Hide the view controls"/);
  assert.match(html, /class="dock-open" id="dockShow" aria-label="Show the view controls"/);
  assert.match(css, /\.viewport:not\(\.dock-min\) \.scroll,\.viewport:not\(\.dock-min\) #rulerLeft,\.viewport:not\(\.dock-min\) \.stage3d\{bottom:var\(--dock-h\)\}/, 'the plan / 3D stop above the dock');
  assert.match(css, /\.fabstack\{flex-direction:row;align-items:center;gap:6px;opacity:\.78;transition:opacity \.15s\}/);
  assert.match(css, /\.fabstack:hover,\.fabstack:focus-within\{opacity:1\}/);
  assert.match(css, /\.viewport\.dock-min \.fabstack>\*:not\(\.dock-open\):not\(\.htour-fab\)\{display:none!important\}/);
  assert.match(css, /\.viewport\.is3d \.fabstack \.zoombar\{display:flex\}/, 'zoom / fit stay in 3D');
  assert.match(js, /\(function wireViewDock\(\)\{/);
  assert.match(js, /const KEY='bps\.viewDock';\n  let st=\{\}; try\{ st=JSON\.parse\(localStorage\.getItem\(KEY\)\|\|'\{\}'\)\|\|\{\}; \}catch\(_\)\{ st=\{\}; \}/);
  assert.match(js, /const keep=\(\)=>\{ try\{ localStorage\.setItem\(KEY, JSON\.stringify\(\{pad:!!st\.pad, min:!!st\.min\}\)\); \}catch\(_\)\{\} \};/);
  assert.match(js, /try\{ if\(viewAtFit && !is3DActive\(\)\) fitView\(\); \}catch\(_\)\{\}/, 'the plan re-fits when the dock opens / folds');
});

/* ---------------- 3) free trial: no separate past-layout dropdown ---------------- */
t('free trial: the "Reference a past layout" dropdown is hidden; its options still feed "From past events"', () => {
  const st = read('public/studio-templates.js');
  assert.match(head, /<div class="field" id="refField">\s*<label for="refEvents">Past events<\/label>/);
  assert.match(st, /fillPast\(sel\);\n[\s\S]{0,400}var rf = \$\("refField"\); if \(rf\) rf\.hidden = true;/);
  assert.match(css, /header\.hr19 #refField\[hidden\],html\.helm-trial header\.hr19 #refField\{display:none\}/);
  assert.match(js, /\$\('#refEvents'\)\.addEventListener\('change'/, 'the loader stays');
});

/* ---------------- 4) the header ---------------- */
t('header: two rows of whole groups, in reading order', () => {
  assert.match(head, /^<header class="hr19">/);
  const rows = head.split('<div class="hrow ');
  assert.equal(rows.length, 3, 'two rows');
  const r1 = rows[1], r2 = rows[2];
  for (const g of ['hg-doc', 'hg-save', 'hg-edit', 'hg-cap']) assert.match(r1, new RegExp('class="hgroup ' + g + '"'), g);
  for (const g of ['hg-start', 'hg-view', 'hg-grid']) assert.match(r2, new RegExp('class="hgroup ' + g + '"'), g);
  const order = ['projName', 'saveBtn', 'loadBtn', 'moreMenu', 'undoBtn', 'redoBtn', 'clearBtn', 'capInput', 'capMeter', 'preset', 'refEvents', 'customBtn', 'viewSeg', 'measureBtn', 'unitSel', 'snapBtn', 'gridBtn'];
  const pos = order.map((id) => head.indexOf('id="' + id + '"'));
  assert.ok(pos.every((p, k) => p > 0 && (k === 0 || p > pos[k - 1])), 'DOM order ' + pos);
  assert.match(head, /id="undoBtn"[^>]*><svg viewBox="0 0 16 16"/, 'undo / redo drawn as icons (the arrow glyphs were missing from the font)');
  assert.match(head, /placeholder="Capacity"/, 'the capacity box says what it is (its label is visually hidden)');
  assert.match(css, /header\.hr19 \.hrow\{display:flex;align-items:center;flex-wrap:wrap;column-gap:10px;row-gap:6px;min-width:0\}/);
  assert.match(css, /header\.hr19 \.hgroup\{gap:6px;flex-wrap:nowrap\}/, 'a group never splits');
  assert.match(css, /html:not\(:has\(\.viewport\.is3d\)\) header\.hr19 \.wt-field \.seg button:not\(#wtStart\)\{display:none\}/, '3D presets only in 3D');
  assert.match(css, /header\.hr19 #fsBtn\{display:none\}/, 'fullscreen lives in the canvas dock');
  assert.match(css, /@media \(max-width:720px\)\{\n  header\.hr19\{flex-direction:row;flex-wrap:nowrap;overflow-x:auto/, 'phones keep the one scrolling strip');
  assert.match(css, /header\.hr19:has\(#quoteBadge:not\(\[hidden\]\)\) \.hg-save \.tl:not\(\.tl-back\)\{display:none\}/, 'inside a quote, Open / More drop their words up to 1440 px');
});

/* ---------------- 5) first-run tour ---------------- */
t('tour: every toolbar control in screen order, auto-started once', () => {
  const tour = read('public/tour.js');
  const blk = tour.slice(tour.indexOf('"builder.html": ['), tour.indexOf('"quotes.html": ['));
  const sels = [...blk.matchAll(/sel: (\[[^\]]*\]|"[^"]*")/g)].map((m) => m[1]);
  assert.ok(sels.length >= 20, 'steps ' + sels.length);
  for (const s of ['"#projName"', '"#saveBtn"', '"#loadBtn"', '"#moreMenu"', '".hg-edit"', '".hg-cap"', '"#preset"', '"#refField"', '"#customBtn"', '"#viewSeg"', '"#measureBtn"', '".hg-grid"', '"#toolbox"', '"#fabStack"', '"#rightPanel"'])
    assert.ok(sels.includes(s), s);
  assert.ok(sels.indexOf('".hg-cap"') < sels.indexOf('"#preset"'), 'row 1 before row 2');
  assert.match(js, /scheduleBuilderTour\(\); \/\/ r19: first visit only/);
  assert.match(js, /const BUILDER_TOUR_SEEN='helm_tour_seen_builder';/);
  assert.match(js, /if\(RO \|\| CAPTURE_HOST \|\| !window\.HelmTour \|\| !HelmTour\.hasSteps\) return;/, 'never for a viewer / the capture host');
  assert.match(js, /try\{ if\(localStorage\.getItem\(BUILDER_TOUR_SEEN\)\) return; \}catch\(_\)\{ return; \}/, 'no storage: never nag');
  assert.match(js, /if\(layoutLoading \|\| builderTourBusy\(\)\)\{ setTimeout\(attempt, 1500\); return; \}/, 'waits for dialogs / loading');
  assert.match(tour, /try \{ localStorage\.setItem\(endKey, "1"\); \} catch \(_\) \{\}/, 'the engine marks it seen when it ends');
});

/* ---------------- 6) 0213 sample floor plans ---------------- */
const sql = read('supabase/migrations/0213_sample_event_layouts.sql');
const plans = {};
for (const m of sql.matchAll(/when '(SMP-\d{4})' then \$j\$([\s\S]*?)\$j\$::jsonb/g)) plans[m[1]] = JSON.parse(m[2]);
// the builder's own catalogue + seat rule
const block = (s) => { let i = js.indexOf('{', s), d = 0; for (; i < js.length; i++) { if (js[i] === '{') d++; else if (js[i] === '}' && --d === 0) break; } return js.slice(s, i + 1); };
const ASSETS = new Function('return ' + block(js.indexOf('const ASSETS = {') + 'const ASSETS = '.length))();
const seatsOf = (it) => { const p = it.properties || {}; if (p.rows && p.cols) return p.rows * p.cols; if (p.seats) return +p.seats || 0; return 0; };
const drawn = (it) => { const q = ((((+it.rotation || 0) % 180) + 180) % 180), r = q > 45 && q < 135;
  const w = r ? it.height : it.width, h = r ? it.width : it.height; return { x: it.x + it.width / 2 - w / 2, y: it.y + it.height / 2 - h / 2, w, h }; };
const hit = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const SOFT = new Set(['dancefloor', 'redcarpet', 'fairylights', 'podium', 'teleprompter']);   // floor / overhead / on-stage pieces
const EXPECT = { 'SMP-1000': [250, 'table'], 'SMP-1002': [220, 'table'], 'SMP-1004': [300, 'table'], 'SMP-1005': [200, 'seatblock'], 'SMP-1006': [150, 'table'] };
t('0213: five plans, each seating exactly its guests within its limit', () => {
  assert.deepEqual(Object.keys(plans).sort(), Object.keys(EXPECT));
  for (const [code, [guests, kind]] of Object.entries(EXPECT)) {
    const p = plans[code], seats = p.items.reduce((s, i) => s + seatsOf(i), 0);
    assert.equal(seats, guests, code + ' seats');
    assert.ok(p.venue.capacity >= guests, code + ' limit');
    assert.ok(p.items.some((i) => i.type === kind), code + ' seating kind');
    assert.deepEqual(p.scale.worldFt, p.venue.room, code + ' hall');
    assert.ok(p.items.filter((i) => i.type === 'table').every((i) => i.properties.seats <= 10), code + ' at most 10 a table');
  }
});
t('0213: every piece is a builder piece, inside the hall exactly where the builder will keep it, nothing overlapping', () => {
  for (const [code, p] of Object.entries(plans)) {
    const W = p.venue.room.w, H = p.venue.room.h, ids = new Set();
    for (const it of p.items) {
      assert.ok(ASSETS[it.type], code + ' unknown piece ' + it.type);
      assert.equal(it.category, ASSETS[it.type].category, code + ' category ' + it.type);
      assert.ok(!ids.has(it.id), code + ' duplicate id ' + it.id); ids.add(it.id);
      // builder clampItem keeps the UNROTATED box inside the hall: the plan must already satisfy it (no silent moves)
      assert.ok(it.x >= 0 && it.y >= 0 && it.x + it.width <= W + 1e-9 && it.y + it.height <= H + 1e-9, code + ' clamp ' + it.label);
      const d = drawn(it); assert.ok(d.x >= -1e-9 && d.y >= -1e-9 && d.x + d.w <= W + 1e-9 && d.y + d.h <= H + 1e-9, code + ' inside ' + it.label);
      assert.ok(/^[\x20-\x7e]+$/.test(it.label), code + ' ASCII label');
    }
    const solid = p.items.filter((i) => !SOFT.has(i.type));
    for (let i = 0; i < solid.length; i++) for (let j = i + 1; j < solid.length; j++)
      assert.ok(!hit(drawn(solid[i]), drawn(solid[j])), code + ': ' + solid[i].label + ' overlaps ' + solid[j].label);
  }
});
t('0213: each plan suits its event (entrance, exits, buffets, stage or mandap)', () => {
  const has = (code, type, label) => plans[code].items.some((i) => i.type === type && (!label || i.label === label));
  for (const c of Object.keys(plans)) {
    assert.ok(plans[c].items.filter((i) => i.type === 'exit' && i.label !== 'Entrance').length >= 2, c + ' exits');
    assert.ok(has(c, 'floralentrance') || has(c, 'exit', 'Entrance'), c + ' entrance');
    assert.ok(plans[c].items.filter((i) => i.type === 'buffet').length >= 2, c + ' buffets');
  }
  for (const c of ['SMP-1000', 'SMP-1002', 'SMP-1004']) assert.ok(has(c, 'stage') && has(c, 'dancefloor') && has(c, 'dj'), c);
  assert.ok(has('SMP-1004', 'fairylights') && has('SMP-1004', 'led'), 'sangeet lights + screens');
  assert.ok(has('SMP-1005', 'brandwall') && has('SMP-1005', 'podium') && has('SMP-1005', 'press') && has('SMP-1005', 'desk'), 'launch');
  assert.ok(has('SMP-1006', 'mandap') && has('SMP-1006', 'rangoli') && !has('SMP-1006', 'dj') && !has('SMP-1006', 'dancefloor'), 'housewarming');
});
t('0213: SQL canon - ASCII, guarded, fill-empty only, one publish, MANIFEST + APPLY + refresh + DB suite', () => {
  assert.ok(!/[^\x00-\x7f]/.test(sql), 'ASCII');
  assert.match(sql, /if exists \(select 1 from public\.helm_trial_seed_manifest m where m\.notes = N\) then return; end if;/);
  assert.match(sql, /if v_added > 0 and exists \(select 1 from public\.quotes x where x\.org_id = M\) then\n    perform public\.publish_sample_manifest\(N\);/);
  assert.match(sql, /and \(v\.object_count > 0 or \(jsonb_typeof\(v\.data -> 'items'\) = 'array' and jsonb_array_length\(v\.data -> 'items'\) > 0\)\)\) then\n    return false; end if;/, 'a drawn floor is never replaced');
  assert.match(sql, /where v\.quote_id = q\.id and v\.version_no = q\.cur and v\.object_count = 0/, 'only the empty version is filled');
  assert.ok(!/\bdelete\s+from\b|\bdrop\s+(table|column)\b|\btruncate\b/i.test(sql), 'nothing deleted / dropped');
  assert.ok(!/update public\.quotes\b/.test(sql), 'quote rows untouched');
  for (const f of ['_a213_sample_layout(text)', '_a213_fill_floor(uuid)', '_a213_fill_trial_layouts(uuid)', '_a213_manifest_note()'])
    assert.ok(sql.includes("'public." + f + "'"), 'revoked: ' + f);
  const man = read('supabase/migrations/MANIFEST');
  const i08 = man.indexOf('forward  supabase/migrations/0208_'), i13 = man.indexOf('forward  supabase/migrations/0213_sample_event_layouts.sql'), i36 = man.indexOf('forward  supabase/migrations/0236_');
  assert.ok(i08 > 0 && i13 > i08 && i36 > i13, 'MANIFEST numeric order');
  const ap = read('supabase/APPLY-0213.sql');
  assert.ok(ap.includes('begin;\n' + sql + '\ncommit;'), 'APPLY carries the migration verbatim');
  assert.match(ap, /-- VERIFY \(every row should say ok = true\)/);
  assert.ok(!/[^\x00-\x7f]/.test(ap), 'APPLY ASCII');
  const rf = read('supabase/APPLY-0213-refresh-trial-layouts.sql');
  assert.match(rf, /select public\._a213_fill_trial_layouts\(\) as sample_events_given_a_floor_plan;/);
  assert.ok(!/[^\x00-\x7f]/.test(rf) && !/\bdelete\s+from\b/i.test(rf), 'refresh: ASCII, nothing deleted');
  assert.match(read('scripts/db-test/run-all.sh'), /run "sample-layouts-0213" "SAMPLE-LAYOUTS-0213: ALL PASS \\\(16\/16\\\)" psql -q -f tests\/db\/sample-layouts-0213\.sql/);
});

console.log(`r19-builder: ${n} checks passed`);
