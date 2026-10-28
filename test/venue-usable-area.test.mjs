// 0096 venue length x breadth + usable area: calc() rules + flow / picker / builder / admin wiring.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const cx = { window: {} }; cx.globalThis = cx; vm.createContext(cx);
vm.runInContext(read('public/venue-area.js'), cx);
vm.runInContext(read('public/venues-core.js'), cx);
const A = cx.window.HelmVenueArea, V = cx.window.HelmVenues;
let n = 0; const t = (name, fn) => { try { fn(); n++; } catch (e) { console.error('FAIL ' + name); throw e; } };

t('label: venue size + area used', () => {
  assert.equal(A.calc({ venueLen: 262, venueWid: 164, len: 180, wid: 120 }).label, 'Venue size 262×164 ft · Using 180×120 ft');
  const f = A.calc({ venueLen: 262, venueWid: 164, len: 262, wid: 164 });
  assert.ok(f.full); assert.match(f.label, /Using the full venue/);
  assert.equal(A.calc({ len: 100, wid: 80 }).label, '', 'no venue -> no label');
});
t('validation: positive + cap are errors; larger than the venue is only a warning', () => {
  assert.equal(A.calc({ len: -5, wid: 10 }).errors[0].field, 'len');
  assert.equal(A.calc({ len: 10, wid: 0 }).errors[0].field, 'wid');
  assert.match(A.calc({ len: 1200, wid: 10, cap: 1000 }).errors[0].msg, /at most 1000/);
  const w = A.calc({ venueLen: 100, venueWid: 80, len: 150, wid: 80 });
  assert.equal(w.errors.length, 0); assert.equal(w.warnings[0].code, 'over_venue');
  assert.equal(A.calc({ venueLen: 100, venueWid: 80, len: 90, wid: 70 }).warnings.length, 0);
});
t('venues: length + breadth are required in Settings', () => {
  assert.ok(!V.validate({ name: 'X', seated_capacity: 10 }).ok);
  const e = V.validate({ name: 'X', seated_capacity: 10, length: '80' }).errors;
  assert.equal(e[0].field, 'width');
  assert.ok(V.validate({ name: 'X', seated_capacity: 10, length: '262', width: '164' }, 'ft').ok);
  assert.ok(!V.validate({ name: 'X', seated_capacity: 10, length: '50000', width: '10' }).ok, 'over the DB limit');
  assert.match(read('public/venues-admin.js'), /"Breadth \(" \+ unit \+ "\) \*"/);
});
t('venues: an EXISTING venue without a size still saves, with a warning', () => {
  const r = V.validate({ name: 'Old hall', seated_capacity: 10 }, 'm', { existing: true });
  assert.ok(r.ok); assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0].msg, /Add length \u00d7 breadth so quotes can size the floor/);
  assert.equal(r.value.length_m, null);
  assert.ok(!V.validate({ name: 'Old', seated_capacity: 10, length: '-1' }, 'm', { existing: true }).ok, 'bad numbers still rejected');
  assert.equal(V.validate({ name: 'N', seated_capacity: 10, length: '5', width: '5' }, 'm', { existing: true }).warnings.length, 0);
  assert.match(read('public/venues-admin.js'), /\{ existing: !!v\.id \}/);
});
t('flow: full venue size kept on the client JSON; hall fields stay the usable area', () => {
  const f = read('public/flow.html');
  assert.match(f, /<input type="hidden" id="v_vlen"><input type="hidden" id="v_vwid">/);
  assert.match(f, /venueLen:vfl, venueWid:vfw/);
  assert.match(f, /hallLen:\$\("#g_len"\)\.value, hallWid:\$\("#g_wid"\)\.value/, 'hallLen/hallWid contract kept');
  assert.match(f, /\$\("#v_vlen"\)\.value=\+cl\.venueLen>0/);
  assert.match(f, /<script src="venue-picker\.js\?v=7"><\/script>\s*<script src="venue-area\.js\?v=2"><\/script>/);
  const a = read('public/venue-area.js');
  assert.match(a, /Reset to full venue/); assert.doesNotMatch(a, /innerHTML/);
});
t('picker: fills hall + remembers venue size; unlink clears it', () => {
  const p = read('public/venue-picker.js');
  assert.match(p, /setVal\("g_len", f\.lenFt\); setVal\("g_wid", f\.widFt\)/);
  assert.match(p, /setRaw\("v_vlen", f\.lenFt\); setRaw\("v_vwid", f\.widFt\)/);
  assert.match(p, /if \(!v\) \{ setRaw\("v_vlen", null\); setRaw\("v_vwid", null\); \}/);
  const fill = V.fillFor({ name: 'Lawn', length_m: 80, width_m: 50 });
  assert.equal(fill.lenFt, 262); assert.equal(fill.widFt, 164);
});
t('builder: keeps the venue size for reference beside the usable floor', () => {
  const b = read('public/builder.js');
  assert.match(b, /venueLen: \(window\.HelmVenues && HelmVenues\.mToFt\(v\.length_m\)\) \|\| null/);
  assert.match(b, / · venue \$\{\+c\.venueLen\} × \$\{\+c\.venueWid\} ft/);
  assert.match(read('public/layout-wizard.js'), /posInt\(cl\.hallLen\) \|\| room\.w/, 'wizard still sizes from the usable area');
});
console.log('venue-usable-area: ok (' + n + ')');
