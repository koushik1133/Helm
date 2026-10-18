// QA (release 1018 local QA, builder): B8 / B9 / B10 / B27.
//   B8   a sample event with current_version 1 and NO quote_versions rows opens as an empty V1 (not "Editing is locked");
//        every other missing / unreadable version still locks
//   B9   the price breakdown lines show the quote's own counts + unit rates (chairPrice / platePrice), so the line maths adds up
//   B10  the quote's menu package (pricing._packageName) is pre-selected when the event plan has none; the plate rate is untouched
//   B27  Hide amounts loads in the builder (not in the capture host); no literal "&amp;"; round tables = ceil(seats / seats per
//        table) and no table is ever given more than its seats; the quote's venue is pre-selected; no "Demo · " in template
//        toasts; version times in the studio time zone
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const js = read('public/builder.js');
let n = 0; const t = (name, fn) => { try { fn(); n++; } catch (e) { console.error('FAIL', name); throw e; } };

// generator loader (same as r8b-seats-exact.test.mjs): lift the pure functions out of builder.js by brace matching
const block = (startAt) => { let i = js.indexOf('{', startAt), depth = 0;
  for (; i < js.length; i++) { if (js[i] === '{') depth++; else if (js[i] === '}' && --depth === 0) break; } return js.slice(startAt, i + 1); };
const fn = (name) => { const s = js.indexOf('function ' + name + '('); assert.ok(s >= 0, name);
  let i = js.indexOf('{', js.indexOf(')', s)), depth = 0;
  for (; i < js.length; i++) { if (js[i] === '{') depth++; else if (js[i] === '}' && --depth === 0) break; }
  return js.slice(s, i + 1); };
const decl = (head) => { const s = js.indexOf(head); assert.ok(s >= 0, head); return block(s) + ';'; };
const line = (head) => { const s = js.indexOf(head); assert.ok(s >= 0, head); return js.slice(s, js.indexOf('\n', s)); };
const G = new Function([
  decl('const ASSETS = {'), 'const WORLD = { w: 200, h: 140 };', line('const clamp = '), line('const round1 = '),
  line('const DESIGN_PITCH='), 'let _packFit = null; let uid = 1; const nid = () => "o" + (uid++); const catColor = () => "#000";',
  line('const GEN_OVERLAY = '), line('const SEAT_SQFT_FALLBACK='), line('const SEAT_UNIT = '), line('const FLOOR_SEATS = '), line('const GEN_SEATING = '),
  ...['makeItem', 'genSeats', 'sumSeats', 'setBlockSeats', 'exactSeats', 'seatSqftFor', 'seatFitWarning', 'seatBottom', 'countSeats', 'tally', 'frontZone', 'supportZone', 'seatTheatre', 'seatRounds', 'seatBanquetLong', 'seatBanquetRounds', 'boothGrid',
    'seatPerimeter', 'seatCocktail', 'seatHalfRoundsTheatre', 'clampItem', 'genRect', 'rectsHit', 'resolveOverlaps', 'generateVariants'].map(fn),
  'return { WORLD, generateVariants, sumSeats, exactSeats };',
].join('\n'))();
const tables = (items) => items.filter((i) => i.type === 'table');

t('B8: no version rows + current_version 1 -> empty V1 (first save becomes V1); anything else still locks', () => {
  assert.match(js, /const _noVersionRows = !\(q\.versions\|\|\[\]\)\.length && \+verNo===1 && \(\+q\.currentVersion\|\|1\)===1;/);
  assert.match(js, /const ver = _noVersionRows \? \{ versionNo:1, data:\{ items:\[\] \}, missing:true \} : await BPStore\.quotes\.getVersion\(q\.id, verNo\);/);
  // the old safety net stays: unreadable version data (or a failed read) locks the builder
  assert.match(js, /if\(!ver \|\| !ver\.data \|\| !Array\.isArray\(ver\.data\.items\)\) throw new Error\('version data unreadable'\);/);
  assert.match(js, /applyReadonly\('viewer','🔒 Editing is locked — that quote or version could not be opened\./);
  // the decision itself, as written in builder.js
  const decide = (versions, verNo, cur) => !(versions || []).length && +verNo === 1 && (+cur || 1) === 1;
  assert.equal(decide([], 1, 1), true, 'SMP-1004: V1 pointer, no rows');
  assert.equal(decide([], 1, null), true);
  assert.equal(decide([{ versionNo: 1 }], 1, 1), false, 'a real V1 row is read from the server');
  assert.equal(decide([], 2, 2), false, 'a V2 pointer with no rows is broken data: locked');
  assert.equal(decide([], 3, 1), false, '?v=3 that does not exist: locked');
  // saving appends: add_quote_version numbers from max(version_no)+1, so nothing can be overwritten
  assert.match(read('supabase/phase73-definer-org-isolation-final.sql'), /select coalesce\(max\(version_no\),0\)\+1 into nextno from public\.quote_versions where quote_id = p_quote_id;/);
});

t('B9: the breakdown lines use the quote pricing counts and unit rates (not the studio defaults)', () => {
  const rp = fn('renderPrice');
  assert.match(rp, /m\.chairs=\+qp\.chairs\|\|0; m\.chairPrice=\+qp\.chairPrice\|\|0; m\.guests=\+qp\.guests\|\|0; m\.platePrice=\+qp\.platePrice\|\|0;/);
  assert.match(rp, /m\.cateringCost=\+qt\.plateSub\|\|0; m\.cateringExtra=\+qt\.cateringAmt\|\|0;/);
  assert.match(rp, /if\(m\.cateringExtra>0\) rows\+=/);
  // the line maths now adds up for the SMP-1001 numbers (chairs 450 x 45, plates 450 x 950)
  const qp = { chairs: 450, chairPrice: 45, guests: 450, platePrice: 950 };
  assert.equal(qp.chairs * qp.chairPrice, 20250); assert.equal(qp.guests * qp.platePrice, 427500);
});

t('B10: the quote package (pricing._packageName) is pre-selected when the plan has none; plate rate untouched', () => {
  const P = new Function(fn('pkgNameKey') + fn('pkgFromQuoteName') + 'return { pkgNameKey, pkgFromQuoteName };')();
  const pk = [{ id: 's', name: 'Demo · Silver', price_per_plate: 700 }, { id: 'g', name: 'Demo · Gold — Non-veg', price_per_plate: 1000 }, { id: 'x', name: 'Standard — Non-veg', price_per_plate: 650 }];
  assert.equal(P.pkgFromQuoteName(pk, 'Gold — Non-veg').id, 'g', 'sample "Demo · " prefix ignored');
  assert.equal(P.pkgFromQuoteName(pk, 'standard  —  non-veg').id, 'x', 'case / spacing ignored');
  assert.equal(P.pkgFromQuoteName(pk, 'Demo · Standard — Non-veg').id, 'x');
  assert.equal(P.pkgFromQuoteName(pk, 'Platinum'), null);
  assert.equal(P.pkgFromQuoteName(null, 'Gold'), null);
  assert.equal(P.pkgFromQuoteName(pk, ''), null);
  const blk = js.slice(js.indexOf('// QA-B10: the event plan has no package'), js.indexOf('buildMenuControls();', js.indexOf('// QA-B10: the event plan has no package')));
  assert.match(blk, /if\(!PRICING\.menuPackageName && currentPricing && currentPricing\._packageName\)/);
  assert.match(blk, /if\(pk && !PRICING\.appliedPkgId\) PRICING\.appliedPkgId = pk\.id;/);
  assert.doesNotMatch(blk, /menuPlatePrice\s*=/, 'opening the builder never moves the plate rate');
});

t('B27: Hide amounts is loaded in the builder (eye button in the header), never in the capture host', () => {
  const html = read('public/builder.html'), cap = read('public/capture.html');
  assert.match(html, /<link rel="stylesheet" href="\/shell-b-privacy\.css\?v=\d+">/);
  assert.match(html, /<script src="\/shell-b-privacy\.js\?v=\d+"><\/script>\n<script src="telemetry\.js\?v=\d+"><\/script>/, 'first script, before the page renders amounts');
  assert.match(html, /<span class="hb-tools bp-priv-slot"><\/span>/);
  assert.match(html, /<svg id="svg" class="hbp-skip"/);
  assert.doesNotMatch(cap, /(src|href)="\/shell-b-privacy/);
  assert.match(read('scripts/gen-capture-host.mjs'), /shell-b-privacy\\\.js/);
  assert.match(read('public/shell-b-privacy.js'), /if \(node\.closest && node\.closest\("\.hbp-skip"\)\) return;/);
  assert.match(read('public/builder-v2.css'), /header \.bp-priv-slot \.hbp-btn \{/);
});

t('B27: no literal "&amp;" in the variant text (it is escaped when rendered)', () => {
  assert.match(js, /finish\(it,'Custom mix','Your exact selections — drop & edit freely'\);/);
  assert.doesNotMatch(js, /drop &amp; edit/);
});

t('B27: round tables = ceil(chairs / seats per table); no table above its seats; exactly N seats', () => {
  for (const [w, h, minTables] of [[200, 140, 53], [120, 90, 53], [100, 80, 30], [60, 40, 1]]) {
    G.WORLD.w = w; G.WORLD.h = h;
    for (const o of [{ type: 'product_launch', guests: 600, chairs: 420, tables: 53, spt: 8, stage: true, buffet: true },
      { type: 'wedding', guests: 600, chairs: 420, spt: 8 }]) {
      const vs = G.generateVariants(o);
      for (const name of ['Round tables', 'Custom mix', 'Mixed reception']) {
        const v = vs.find((x) => x.name === name); if (!v) continue;
        assert.equal(G.sumSeats(v.items), 420, `${w}x${h} ${o.type} ${name} seats`);
        const tb = tables(v.items);
        assert.ok(tb.every((x) => +x.properties.seats <= 8), `${w}x${h} ${o.type} ${name}: a table has ${Math.max(...tb.map((x) => x.properties.seats))} seats`);
        if (name === 'Round tables' && o.type === 'product_launch') assert.ok(tb.length >= minTables, `${w}x${h} ${o.type} round tables ${tb.length} < ${minTables}`);
      }
    }
  }
  G.WORLD.w = 200; G.WORLD.h = 140;
  // 420 at 10 per table -> 42 tables of 10 (the form's seats per table is used, not 8)
  const v10 = G.generateVariants({ type: 'wedding', guests: 600, chairs: 420, spt: 10 }).find((x) => x.name === 'Round tables');
  assert.equal(tables(v10.items).length, 42); assert.ok(tables(v10.items).every((x) => +x.properties.seats <= 10));
  // exactSeats on its own: tables are topped up only to their seats; the rest becomes a seat block
  const tabs = () => [0, 1, 2].map((i) => ({ id: 't' + i, type: 'table', x: 10 + i * 9, y: 10, width: 6, height: 6, properties: { seats: i === 2 ? 5 : 8 } }));
  const a = G.exactSeats(tabs(), 24); assert.equal(G.sumSeats(a), 24); assert.deepEqual(tables(a).map((x) => x.properties.seats), [8, 8, 8]);
  const b = G.exactSeats(tabs(), 40); assert.equal(G.sumSeats(b), 40); assert.ok(tables(b).every((x) => x.properties.seats <= 8));
  assert.equal(b.filter((x) => x.type === 'seatblock').length, 1, 'the 16 extra seats are a seat block');
});

t('B27: the quote venue is pre-selected (linked id, else the saved venue the quote names) - display only', () => {
  const s = js.indexOf('linkedId(rows){'); assert.ok(s > 0);
  const body = block(s).replace(/^linkedId\(rows\)/, 'function linkedId(rows)');
  const mk = (client) => new Function('currentClient', body + '; return linkedId;')(client);
  const rows = [{ id: 'v1', name: 'Demo · Grand Lawn' }, { id: 'v2', name: 'Rooftop' }];
  assert.equal(mk({ venueId: 'v2' })(rows), 'v2');
  assert.equal(mk({ venue: 'Demo · Grand Lawn' })(rows), 'v1', 'sample events: client.venue name');
  assert.equal(mk({ venueName: 'grand  lawn' })(rows), 'v1');
  assert.equal(mk({ venue: 'Somewhere else' })(rows), '');
  assert.equal(mk({})(rows), '');
  assert.equal(mk(null)(rows), '');
  const vp = read('public/venue-picker.js'), wz = read('public/layout-wizard.js');
  assert.match(vp, /preselect: function \(rows\) \{ var B = window\.HelmBuilderVenue; return B && B\.linkedId \? B\.linkedId\(rows\) : ""; \}/);
  assert.match(vp, /var pre = ctx\.preselect \? ctx\.preselect\(list\) : "";/);
  assert.match(wz, /const linkedId = venuePicked \|\| \(B && B\.linkedId \? B\.linkedId\(rows\) :/);
  assert.match(js, /if\(!wasOpen && window\.HelmVenuePicker && HelmVenuePicker\.where==='builder'\) HelmVenuePicker\.sync\(\);/);
});

t('B27: template toasts / names drop the "Demo · " sample prefix', () => {
  const st = read('public/studio-templates.js');
  assert.match(st, /var nm = trialName\(row\.name\) \|\| row\.name;/);
  assert.match(st, /li\(items, nm\);/);
  assert.match(st, /toast\(nm \+ " loaded"/);
  assert.doesNotMatch(st, /toast\(row\.name \+ " loaded"/);
  // the price breakdown's catering line shows the package without the sample prefix (the stored name is unchanged)
  assert.match(fn('renderPrice'), /esc\(String\(PRICING\.menuPackageName\)\.replace\(\/\^\\s\*Demo \\u00b7 \/,''\)\)/);
});

t('B27: version times use the studio time zone (BPStore.fmtStudioDate), browser clock only as a fallback', () => {
  const src = fn('versionOptionLabel');
  const withStore = new Function('BPStore', src + '; return versionOptionLabel;');
  const seen = [];
  const lbl = withStore({ fmtStudioDate: (v, o) => { seen.push([v, o]); return '18 Oct 2026, 08:38 pm'; } })({ versionNo: 2, createdAt: '2026-10-18T15:08:00Z' }, 2, null, null);
  assert.equal(lbl, 'V2 (latest) · 18 Oct 2026, 08:38 pm');
  assert.equal(seen[0][0], '2026-10-18T15:08:00Z'); assert.equal(seen[0][1].fmt.hour, '2-digit');
  // no store (unit test / very old page): still a label
  const bare = new Function(src + '; return versionOptionLabel;')();
  assert.match(bare({ versionNo: 1, createdAt: '2026-10-18T15:08:00Z' }, 1), /^V1 \(latest\) · .+/);
  // a real zone: IST for an Indian studio, whatever the browser clock says
  const real = withStore({ fmtStudioDate: (v, o) => new Date(v).toLocaleString('en-IN', Object.assign({}, o.fmt, { timeZone: 'Asia/Kolkata' })) });
  assert.match(real({ versionNo: 1, createdAt: '2026-10-18T09:38:00Z' }, 1), /03:08\s?pm/i);
});

t('B27 review: the menu package options carry no per-plate rate while Hide amounts is on (options are never masked)', () => {
  const bm = fn('buildMenuControls');
  assert.match(bm, /const hideAmt=document\.documentElement\.classList\.contains\('hb-priv-on'\);/);
  assert.match(bm, /\$\{hideAmt\?'':' · '\+inr\(p\.price_per_plate\)\+'\/plate'\}/);
  assert.match(js, /new MutationObserver\(\(\)=>\{ const on=document\.documentElement\.classList\.contains\('hb-priv-on'\); if\(on===_privWas\) return;/);
});

console.log(`qa-builder-1018: ${n} checks ok`);
