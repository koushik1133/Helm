// uae-live.test.mjs - live UAE test fixes (Oct 2026): U1 client emirate list follows the studio /
// quote country, U2 builder metres default for non-IN/US, U4 wizard needs guests, U5 remembered
// wizard choices never override the quote with blanks, U6 0103 real demo package count,
// Gulf gala / iftar / exhibition wizard suggestions.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const W = require('../public/layout-wizard.js');
const tests = []; const t = (n, f) => tests.push([n, f]);

t('U1 flow client state list follows the quote snapshot, else the studio country (not rates before load)', () => {
  const f = read('public/flow.html');
  assert.match(f, /function clientCountry\(\)/);
  assert.match(f, /const cc=clientCountry\(\); const m=HC\.formMeta\(cc\)/);
  assert.match(f, /BPStore\.studioTax\(\)/);
  assert.match(f, /paintCurBanner\(\); try\{ const cur=\$\("#c_state"\)\.value; fillClientStates\(/, 're-filled after rates load');
  const H = require('../public/country-profile.js');
  assert.equal(H.formMeta('AE').regionLabel, 'Emirate'); assert.equal(H.formMeta('AE').regions.length, 7);
  assert.equal(H.formMeta('US').regionLabel, 'State');
});
t('U2 builder unit: user pick remembered, else IN/US feet, others metres (new + existing quotes)', () => {
  const b = read('public/builder.js');
  assert.match(b, /const UNIT_PREF_KEY='helm\.builderUnit'/);
  assert.match(b, /grid: \{ snap:true, show:true, unit:defaultUnit\(\)/);
  assert.match(b, /const pu=userUnitPref\(\); if\(pu\) store\.grid\.unit=pu; else if\(countryUnit\(\)==='m'\) store\.grid\.unit='m'/);
  assert.match(b, /localStorage\.setItem\(UNIT_PREF_KEY, store\.grid\.unit\)/);
  assert.match(read('public/store-api.js'), /"helm\.builderUnit", "helm\.studioTax"\]/, 'cleared on sign-out (per user)');
});
t('U4 wizard requires guests or seats > 0', () => {
  assert.equal(W.needsGuests({ guests: 0, chairs: 0 }), true);
  assert.equal(W.needsGuests({ guests: '', chairs: '' }), true);
  assert.equal(W.needsGuests({ guests: 250, chairs: 0 }), false);
  assert.equal(W.needsGuests({ guests: 0, chairs: 40 }), false);
  const s = read('public/layout-wizard.js');
  assert.match(s, /function guardGuests\(\)/); assert.match(s, /bNext\.addEventListener\('click', \(\) => \{ if \(!guardGuests\(\)\) return;/);
  assert.match(s, /role: 'alert'/); assert.match(s, /const remember = \(\) => \{ if \(needsGuests\(spec\)\) return;/);
});
t('U5 remembered choices: quote wins on blanks or when quote guests/chairs/hall/type changed', () => {
  const fresh = () => W.defaults('galadinner', { country: 'AE', guests: 250, chairs: 175, w: 120, h: 80 });
  const blank = W.defaults('galadinner', { country: 'AE', guests: 0, chairs: 0, w: 120, h: 80 });
  let r = W.mergeRemembered(blank, fresh()); assert.equal(r.guests, 250); assert.equal(r.chairs, 175);
  const f1 = fresh(); const saved = W.mergeRemembered(null, f1); saved.seating.spt = 12;   // user tweak, same quote
  r = W.mergeRemembered(JSON.parse(JSON.stringify(saved)), fresh()); assert.equal(r.seating.spt, 12, 'unchanged quote keeps the remembered tweak');
  const f2 = W.defaults('galadinner', { country: 'AE', guests: 300, chairs: 210, w: 120, h: 80 });
  r = W.mergeRemembered(JSON.parse(JSON.stringify(saved)), f2); assert.equal(r.guests, 300); assert.equal(r.seating.spt, 10);
  assert.equal(W.mergeRemembered(null, fresh()).guests, 250);
});
t('Gala dinner suggestions: no mandap, head table, mocktail/bar, VIP lounge, registration, 10 per table (AE)', () => {
  assert.equal(W.typeKey('Gala dinner', 'AE'), 'galadinner'); assert.equal(W.typeKey('Annual Gala', 'US'), 'galadinner'); assert.equal(W.typeKey('Gala dinner'), 'wedding', 'India unchanged');
  assert.equal(W.defaults('Gala dinner', { country: 'AE' }).type, 'galadinner');
  const g = W.defaults('galadinner', { country: 'AE', guests: 300 });
  assert.equal(g.objects.mandap, undefined); assert.equal(g.objects.caketable, undefined);
  for (const k of ['stage', 'led', 'headtable', 'mocktail', 'buffet', 'dj', 'desk', 'vipsofa', 'entrance']) assert.ok(g.objects[k] && g.objects[k].on, 'on ' + k);
  for (const k of ['dancefloor', 'photobooth']) assert.ok(g.objects[k] && !g.objects[k].on, 'optional ' + k);
  assert.equal(g.seating.spt, 10);
  assert.equal(W.defaults('galadinner', { country: 'IN', guests: 300 }).seating.spt, 8);
});
t('Iftar: majlis, sofas, buffet, prayer area, shisha off; no DJ / dance floor / bar', () => {
  const i = W.defaults('iftar', { country: 'AE', guests: 120 });
  for (const k of ['majlis', 'vipsofa', 'buffet', 'prayer']) assert.ok(i.objects[k].on, k);
  assert.ok(i.objects.shisha && !i.objects.shisha.on);
  for (const k of ['dj', 'dancefloor', 'bar', 'mocktail', 'mandap']) assert.equal(i.objects[k], undefined, k);
});
t('Exhibition: booth grid + registration, stage optional, no dance floor / standing dance zone', () => {
  const e = W.defaults('exhibition', { country: 'AE', guests: 500 });
  assert.ok(e.objects.booths.on && e.objects.booths.qty >= 6); assert.ok(e.objects.desk.on); assert.ok(!e.objects.stage.on);
  assert.equal(e.objects.dancefloor, undefined); assert.equal(e.objects.standing, undefined);
});
// placement with a minimal builder stand-in
const ASSETS = new Proxy({}, { get: (o, k) => ({ w: k === 'booth' ? 10 : k === 'headtable' ? 18 : k === 'lounge' ? 12 : 6, h: k === 'booth' ? 10 : k === 'headtable' ? 3 : k === 'lounge' ? 9 : 4 }) });
const deps = { ASSETS, makeItem: (type, x, y, o) => ({ type, x, y, width: o.width, height: o.height, label: o.label, properties: o.properties || {} }),
  genSeats: (it) => { const p = it.properties || {}; if (p.rows && p.cols) return p.rows * p.cols; return +p.seats || 0; } };
t('layouts place the new objects (head table, mocktail, majlis, prayer area, booths) and real guest tables', () => {
  const g = W.layout(W.defaults('galadinner', { country: 'AE', guests: 250, chairs: 175, w: 200, h: 140 }), deps);
  assert.ok(g.items.some((x) => x.type === 'headtable')); assert.ok(g.items.some((x) => /Mocktail/.test(x.label)));
  assert.ok(g.items.filter((x) => x.type === 'table').length >= 10, 'guest tables'); assert.ok(!g.items.some((x) => x.type === 'mandap'));
  const i = W.layout(W.defaults('iftar', { country: 'AE', guests: 120, w: 200, h: 140 }), deps);
  assert.ok(i.items.some((x) => /Majlis/.test(x.label))); assert.ok(i.items.some((x) => x.label === 'Prayer area'));
  const e = W.layout(W.defaults('exhibition', { country: 'AE', guests: 400, w: 200, h: 140 }), deps);
  assert.ok(e.items.filter((x) => x.type === 'booth').length >= 6); assert.ok(!e.items.some((x) => x.type === 'dancefloor'));
});
t('U6 0103: AE demo seed returns the real inserted package count; India seed untouched', () => {
  const s = read('supabase/migrations/0103_uae_demo_counts.sql');
  assert.ok(/^[\x00-\x7f]*$/.test(s));
  assert.match(s, /get diagnostics n_pk = row_count/); assert.match(s, /'packages', n_pk, 'packages_skipped', 2 - n_pk/);
  assert.ok(!/create or replace function public\._demo_seed\(/.test(s), 'India seed not re-issued');
  assert.ok(!/\b(drop|delete|truncate|alter table)\b/i.test(s.replace(/--.*$/gm, '')));
  assert.match(read('supabase/migrations/MANIFEST'), /forward  supabase\/migrations\/0103_uae_demo_counts\.sql/);
  const a = read('supabase/APPLY-0103.sql'); assert.ok(/^[\x00-\x7f]*$/.test(a)); assert.match(a, /\) v\(item, ok\)/); assert.match(a, /^begin;$/m); assert.match(a, /^commit;$/m);
});
t('cache-bust: store-api v174, builder v42, layout-wizard v7', () => {
  const bh = read('public/builder.html');
  assert.match(bh, /store-api\.js\?v=174/); assert.match(bh, /builder\.js\?v=42/); assert.match(bh, /layout-wizard\.js\?v=7/);
  assert.match(read('public/flow.html'), /store-api\.js\?v=174/);
});

let fail = 0;
for (const [n, f] of tests) { try { f(); console.log('ok -', n); } catch (e) { fail++; console.log('FAIL -', n, '\n ', e.message); } }
console.log(fail ? `uae-live: ${fail} failed` : `uae-live: all ${tests.length} passed`);
if (fail) process.exit(1);
