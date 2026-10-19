// r21 political layout (owner, long-pending): the free-trial "Sample layouts" swap Reception - Lawn reception for the
// owner's own POLITICAL RALLY layout (his builder export, 350 x 550 ft, 5,000 seats; the stray Chiavari chair at 0,0
// from the export is left out). Server: 0251 (sample master + existing trial studios + one new manifest).
// Front end: every object type exists in the builder catalogue and has a 3D model; long fence / barrier lines drawn
// top-to-bottom are turned in 3D (they came out as 1 ft stubs); a Political event lists the sample first;
// a hall smaller than 350 x 550 ft gets the fit-to-hall question.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0; const t = (name, fn) => { try { fn(); n++; } catch (e) { console.error('FAIL', name); throw e; } };
const ascii = (s) => /^[\x09\x0a\x0d\x20-\x7e]*$/.test(s);

const MIG = read('supabase/migrations/0251_political_rally_layout.sql');
const APPLY = read('supabase/APPLY-0251.sql');
const MAN = read('supabase/migrations/MANIFEST');
const B = read('public/builder.js');
const B3 = read('public/builder-3d.js');
const POL = "E'Demo \\u00b7 Political rally \\u2014 5,000 seats'";
const REC = "E'Demo \\u00b7 Reception \\u2014 Lawn reception with sofa lounge (450 guests)'";
const code = (s) => s.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');   // ROLLBACK notes are comments

const dm = MIG.match(/POL_DATA constant jsonb := '([^']*)'::jsonb;/);
const DATA = dm ? JSON.parse(dm[1]) : null;
const items = DATA ? DATA.items : [];

t('0251: ASCII, additive (no drop / truncate / delete / alter / create function), REQUIRES guards, listed once in MANIFEST', () => {
  assert.ok(ascii(MIG), 'migration ASCII'); assert.ok(ascii(APPLY), 'APPLY ASCII');
  assert.doesNotMatch(code(MIG), /\b(drop\s+\w+|truncate|delete\s+from|alter\s+(table|function)|create\s+(or\s+replace\s+)?(function|table|trigger|policy|index))\b/i);
  assert.match(MIG, /raise exception 'STOP: 0096/); assert.match(MIG, /raise exception 'STOP: 0237/);
  assert.match(MIG, /^-- ROLLBACK/m);
  assert.equal(MAN.split('\n').filter((l) => l === 'forward  supabase/migrations/0251_political_rally_layout.sql').length, 1);
});

t('APPLY-0251 = begin + the migration verbatim + commit + VERIFY rows', () => {
  const i = APPLY.indexOf('\nbegin;\n'), j = APPLY.indexOf('\ncommit;\n');
  assert.ok(i > 0 && j > i, 'begin ... commit');
  assert.ok(APPLY.slice(i, j).includes(MIG.trim()), 'migration body inside the transaction');
  assert.match(APPLY.slice(j), /select item, ok from \(values/);
  assert.ok((APPLY.slice(j).match(/\('0\d /g) || []).length >= 6);
});

t('the layout: owner export minus the stray chair - 73 objects, 20 x 250 = 5,000 seats, 350 x 550 ft, capacity 5000, 1 ft grid', () => {
  assert.ok(DATA, 'POL_DATA literal parses');
  assert.equal(items.length, 73);
  assert.ok(!items.some((i) => i.type === 'chiavari'), 'stray Chiavari chair left out');
  const blocks = items.filter((i) => i.type === 'seatblock');
  assert.equal(blocks.length, 20);
  assert.ok(blocks.every((b) => b.properties.cols * b.properties.rows === 250));
  assert.equal(blocks.reduce((s, b) => s + b.properties.cols * b.properties.rows, 0), 5000);
  assert.deepEqual(DATA.scale.worldFt, { w: 350, h: 550 });
  assert.equal(DATA.venue.capacity, 5000); assert.equal(DATA.grid.sizeFt, 1);
  assert.equal(new Set(items.map((i) => i.id)).size, 73, 'unique ids');
  for (const i of items) {
    assert.ok(i.x >= 0 && i.y >= 0 && i.x + i.width <= 350.01 && i.y + i.height <= 550.01, i.id + ' inside the ground');
    assert.ok(i.width > 0 && i.height > 0 && isFinite(i.rotation));
  }
  const lab = items.map((i) => i.label).join('|');
  for (const want of ['MAIN STAGE | 100 x 50 ft', 'ARTIST STAGE', 'CENTER RUNWAY', 'INTERACTION AREA', 'GREEN ROOM WEST', 'INAUGURATION PLAQUE',
    'FRONT CONTROL LINE', 'RUNWAY WEST BARRIER', 'PRESS / MEDIA', 'AUDIENCE 4', 'ENTRY 4', 'REAR FENCE', 'PERIMETER', 'SIDE EXIT', 'FOH',
    'FIRST AID', 'RESTROOM', 'ARTIST ACCESS', 'GENERATOR', 'POWER DISTRIBUTION', 'Truss Tower']) assert.ok(lab.includes(want), want);
  assert.equal(items.filter((i) => i.type === 'exit').length, 8);
  assert.equal(items.filter((i) => i.type === 'redcarpet' && i.label === 'Carpet / Aisle').length, 4);
});

t('every object type is in the builder catalogue and has its own 3D model (no generic box)', () => {
  const types = [...new Set(items.map((i) => i.type))].sort();
  assert.deepEqual(types, ['arch', 'checkpoint', 'distro', 'exit', 'fence', 'firstaid', 'foh', 'generator', 'greenroom', 'redcarpet',
    'restroom', 'seatblock', 'stage', 'stagebarrier', 'truss']);
  const cat = B.slice(B.indexOf('const ASSETS = {'), B.indexOf('};', B.indexOf('const ASSETS = {')));
  for (const ty of types) {
    assert.match(cat, new RegExp('\\n\\s*' + ty + ':\\s*\\{\\s*label:'), ty + ' in ASSETS');
    assert.match(B3, new RegExp("case '" + ty + "'"), ty + ' has a 3D case');
  }
});

t('3D: fence / stage barrier / barricade drawn top-to-bottom are built along their long side and turned a quarter', () => {
  assert.match(B3, /const LINEAR_RUN=\{fence:1, stagebarrier:1, barricade:1\};/);
  const f = B3.slice(B3.indexOf('function buildFurniture(it, chairs){'), B3.indexOf('const g=new THREE.Group();', B3.indexOf('function buildFurniture(it, chairs){')));
  assert.match(f, /LINEAR_RUN\[it\.type\] && \+it\.height > \+it\.width/);
  assert.match(f, /width: it\.height, height: it\.width/);
  assert.match(f, /inner\.rotation\.y=Math\.PI\/2/);
  // 2D and 3D share one position rule: centre at (x + w/2, y + h/2), y -> z
  assert.match(B3, /g\.position\.set\(sx\(it\.x\+it\.width\/2\),0,sz\(it\.y\+it\.height\/2\)\)/);
  // the layout really has such lines (perimeter fences 1 x 222 ft, runway barriers 1.5 x 67 ft)
  assert.ok(items.filter((i) => (i.type === 'fence' || i.type === 'stagebarrier') && i.height > i.width).length >= 10);
});

t('2D: carpet aisles under the seat blocks are drawn first (floor coverings), the seat blocks keep their order', () => {
  const T = (() => { const ctx = { window: {}, globalThis: {}, module: { exports: {} } }; vm.runInNewContext(read('public/builder-tools.js'), ctx); return ctx.module.exports; })();
  const order = T.drawOrder(items, { w: 350, h: 550 });
  const firstSeat = order.findIndex((i) => i.type === 'seatblock');
  const lastCarpet = order.map((i) => i.type).lastIndexOf('redcarpet');
  assert.ok(lastCarpet < firstSeat, 'every carpet before the first seat block');
  assert.equal(order.length, 73);
});

t('a hall smaller than 350 x 550 ft gets the fit-to-hall question; the fit keeps every object inside the hall', () => {
  const ctx = { window: {}, globalThis: {} }; ctx.window = ctx; vm.runInNewContext(read('public/load-fit.js'), ctx);
  const LF = ctx.HelmLoadFit;
  const sz = LF.size(DATA);
  assert.equal(sz.w, 350); assert.equal(sz.h, 550);
  assert.equal(LF.compare(sz, { w: 200, h: 140 }).any, true);
  assert.equal(LF.compare(sz, { w: 350, h: 550 }).any, false);
  const C = (() => { const c = { window: {}, module: { exports: {} } }; vm.runInNewContext(read('public/studio-templates-core.js'), c); return c.module.exports; })();
  const fit = C.fitToHall(DATA, { w: 200, h: 300 }, 1000);
  assert.equal(fit.items.length, 73);
  for (const i of fit.items) assert.ok(i.x >= -0.01 && i.y >= -0.01 && i.x + i.width <= 200.01 && i.y + i.height <= 300.01, i.id + ' inside');
});

t('event type: political (a template key); a Political / rally event lists the Political rally sample first', () => {
  assert.match(MIG, /values \(M, POL, 'political', POL_DESC, POL_DATA\)/);
  assert.match(MIG, new RegExp('POL constant text := ' + POL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ';'));
  const C = (() => { const c = { window: {}, module: { exports: {} } }; vm.runInNewContext(read('public/studio-templates-core.js'), c); return c.module.exports; })();
  assert.ok(C.EVENT_TYPES.some((e) => e[0] === 'political'));
  const rows = [{ id: 'w', name: 'Demo \u00b7 Wedding \u2014 Grand Lawn', event_type: 'wedding' },
    { id: 'c', name: 'Demo \u00b7 Corporate \u2014 Round tables gala', event_type: 'corporate' },
    { id: 'p', name: 'Demo \u00b7 Political rally \u2014 5,000 seats', event_type: 'political' }];
  for (const ev of ['Political', 'political', 'Political rally', 'rally', ' POLITICAL ']) assert.equal(C.order(rows, ev)[0].id, 'p', ev);
  assert.equal(C.order(rows, 'Wedding')[0].id, 'w');
  assert.equal(C.order(rows, 'Corporate')[0].id, 'c');
  assert.equal(C.typeKey('Product launch'), 'product_launch');
  assert.deepEqual(C.order(rows, '').map((r) => r.id), ['c', 'p', 'w'], 'no event type: by name');
  // the event-name list the quote form uses has "Political"
  assert.match(read('public/event-name.js'), /EVENT_TYPE_LIST = \[[^\]]*"Political"/);
});

t('existing data: master Reception archived (never deleted); trial Reception archived only while unchanged; paid studios never', () => {
  const c = code(MIG);
  assert.match(c, /update public\.studio_layout_templates set archived = true, is_default = false, updated_at = now\(\)\s+where org_id = M and name = REC and not archived;/);
  assert.match(c, /ss\.status = 'trial'/);
  assert.match(c, /not coalesce\(x\.is_sample_master, false\)/);
  assert.match(c, /t\.data = v_master_rec or public\._a237_fit_layout\(t\.data\) = v_master_rec/);
  assert.match(c, /if not exists \(select 1 from public\.studio_layout_templates s where s\.org_id = M and s\.name = POL\)/);
  assert.match(c, /s\.name like E'Demo \\u00b7 %'/, 'only studios still showing sample layouts get the new one');
  assert.match(MIG, new RegExp('REC constant text := ' + REC.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ';'));
  assert.match(c, /perform public\.publish_sample_manifest\('political rally layout \(0251\)'\)/);
  assert.match(c, /not exists \(select 1 from public\.helm_trial_seed_manifest m where m\.notes = 'political rally layout \(0251\)'\)/);
});

t('2D: FIT can zoom out to 10% so the whole 350 x 550 ft ground fits one screen; ruler numbers thin out instead of overlapping', () => {
  assert.match(B, /^const ZOOM_MIN=0\.1;$/m);
  assert.ok(B.indexOf('const ZOOM_MIN=0.1;') < B.indexOf('const ASSETS = {'), 'defined before any init code');
  assert.match(B, /z=clamp\(z,ZOOM_MIN,3\);/);
  assert.match(B, /store\.view\.zoom=clamp\(Math\.min\(zx,zy\),ZOOM_MIN,3\);/);
  assert.doesNotMatch(B, /clamp\([^)]*,0\.25,3\)/);
  assert.match(B, /const labEvery=10\*\(\[1,2,5,10,20,50\]\.find\(k=>10\*k\*cell\*ppuFt>=30\)\|\|100\), tickOk=cell\*ppuFt>=3;/);
  assert.equal((B.match(/if\(major && unitIndex%labEvery===0\)\{/g) || []).length, 2);
  assert.equal((B.match(/if\(!major && !tickOk\) continue;/g) || []).length, 2);
  // the usual zoom (12 px/ft at 100%, 1 ft grid): every 10th unit numbered, every tick drawn - unchanged
  const step = (ppuFt) => 10 * ([1, 2, 5, 10, 20, 50].find((k) => 10 * k * 1 * ppuFt >= 30) || 100);
  assert.equal(step(12), 10); assert.equal(step(3), 10); assert.equal(step(1.2), 50, "10% zoom: a number every 50 ft");
});

t('3D behaviour: every object of the layout builds parts; a 1 x 222 ft fence = a 222 ft fence turned a quarter (not a 1 ft stub)', () => {
  const b3fn = (name) => { const s = B3.indexOf('function ' + name + '('); let i = B3.indexOf('{', B3.indexOf(')', s)), d = 0;
    for (; i < B3.length; i++) { if (B3[i] === '{') d++; else if (B3[i] === '}' && --d === 0) break; } return B3.slice(s, i + 1); };
  const b3line = (head) => { const s = B3.indexOf(head); assert.ok(s >= 0, head); return B3.slice(s, B3.indexOf('\n', s)); };
  const v3 = () => ({ x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }, setScalar() { return this; } });
  class Obj { constructor(...a) { this.args = a; this.position = v3(); this.rotation = v3(); this.scale = v3(); this.children = []; this.material = a[1] || {}; }
    add(c) { assert.ok(c, 'add(undefined)'); this.children.push(c); return this; } translate() { return this; } rotateX() { return this; } rotateZ() { return this; } }
  const THREE = new Proxy({}, { get: () => Obj });
  const build = new Function('THREE', 'store', 'congestionOf', 'CONG_COLORS', 'label', 'chairs', [b3fn('rotOff'), b3line('const col = '), b3line('const mat = '),
    b3fn('boxMesh'), 'function buildPremium(){ return false; }', b3fn('buildFurniture'), 'return buildFurniture;'].join('\n'))(THREE, {}, () => 'ok', {}, () => new Obj(), []);
  for (const it of items) {
    const g = build(JSON.parse(JSON.stringify(it)), []);
    if (it.type === 'seatblock') { assert.equal(g, null, 'seat blocks are instanced chairs'); continue; }
    assert.ok(g && g.children.length > 0, it.id + ' ' + it.type + ' has 3D parts');
  }
  const posts = (g) => { let n = 0; const walk = (o) => { (o.children || []).forEach((c) => { n++; walk(c); }); }; walk(g); return n; };
  const tall = build({ id: 'f', type: 'fence', x: 0, y: 0, width: 1, height: 222, rotation: 0, color: '#e5484d', properties: {} }, []);
  const wide = build({ id: 'f', type: 'fence', x: 0, y: 0, width: 222, height: 1, rotation: 0, color: '#e5484d', properties: {} }, []);
  assert.equal(tall.children.length, 1); assert.equal(tall.children[0].rotation.y, Math.PI / 2);
  assert.equal(posts(tall) - 1, posts(wide), 'same posts + mesh as the same fence drawn left-to-right');
  assert.ok(posts(wide) > 20, 'a 222 ft fence has many posts');
  const bar = build({ id: 'b', type: 'stagebarrier', x: 0, y: 0, width: 1.5, height: 67, rotation: 0, color: '#e5484d', properties: {} }, []);
  assert.ok(posts(bar) > 20, 'a 67 ft runway barrier drawn top-to-bottom has its panels');
});

console.log(`r21-political-template: ${n} passed`);
