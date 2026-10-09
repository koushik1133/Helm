// 0085 venues: pure logic (validation, m<->ft, warnings) + wiring (pages, versions, area, SQL shape).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const cx = { window: {} }; cx.globalThis = cx; vm.createContext(cx);
vm.runInContext(read('public/venues-core.js'), cx);
const V = cx.window.HelmVenues;
let n = 0; const t = (name, fn) => { fn(); n++; };

t('m <-> ft conversion', () => {
  assert.equal(V.toMeters(100, 'ft'), 30.48);
  assert.equal(V.fromMeters(30.48, 'ft'), 100);
  assert.equal(V.fromMeters(60, 'm'), 60);
  assert.equal(V.mToFt(60), 197);
  assert.equal(V.mToFt(40), 131);
  assert.equal(V.toMeters('', 'ft'), null);
});
t('validation: capacity > 0, length/width > 0, cost min <= max', () => {
  const ok = V.validate({ name: 'Hall', seated_capacity: '300', length: '100', width: '60', cost_min: '100000', cost_max: '200000' }, 'ft');
  assert.ok(ok.ok, JSON.stringify(ok.errors));
  assert.equal(ok.value.length_m, 30.48); assert.equal(ok.value.dim_unit, 'ft');
  assert.ok(!V.validate({ name: 'X', seated_capacity: '0' }).ok);
  assert.ok(!V.validate({ name: 'X' }).ok, 'some capacity needed');
  assert.ok(!V.validate({ name: 'X', floating_capacity: '10', length: '-2' }).ok);
  assert.ok(!V.validate({ name: 'X', floating_capacity: '10', width: '0' }).ok);
  const c = V.validate({ name: 'X', floating_capacity: '10', cost_min: '5', cost_max: '1' });
  assert.ok(!c.ok); assert.equal(c.errors[0].field, 'cost_max');
  assert.ok(!V.validate({ name: '', seated_capacity: 5 }).ok);
  assert.ok(!V.validate({ name: 'X', seated_capacity: 5, map_url: 'javascript:alert(1)' }).ok);
  assert.ok(!V.validate({ name: 'X', seated_capacity: 5, sound_curfew: '25:00' }).ok);
  const f = V.validate({ name: 'X', seated_capacity: 5, event_types: ['wedding', 'rave', 'wedding'], restrictions: ['no_alcohol', 'bogus'] });
  assert.deepEqual([...f.value.event_types], ['wedding']); assert.deepEqual([...f.value.restrictions], ['no_alcohol']);
});
const lawn = { name: 'SAMPLE - Green Meadows Lawn', setting: 'outdoor', floating_capacity: 2000, length_m: 80, width_m: 50,
  event_types: ['wedding', 'reception', 'festival', 'concert'], restrictions: ['sound_curfew', 'generator_required'], sound_curfew: '22:00:00' };
const hall = { name: 'Royal', seated_capacity: 450, floating_capacity: 700, event_types: ['wedding', 'birthday'], restrictions: ['no_outside_catering'] };
t('warnings: guests over capacity', () => {
  assert.ok(V.warnings(lawn, { guests: 2500 }).some((w) => w.code === 'capacity' && w.level === 'warn'));
  assert.ok(!V.warnings(lawn, { guests: 1500 }).some((w) => w.code === 'capacity'));
  assert.ok(V.warnings(hall, { guests: 500 }).some((w) => w.code === 'capacity_seated'));
  assert.ok(V.warnings(hall, { guests: 800 }).some((w) => w.code === 'capacity'));
});
t('warnings: event type not allowed', () => {
  assert.ok(V.warnings(hall, { eventType: 'Concert / live music' }).some((w) => w.code === 'event_type'));
  assert.ok(!V.warnings(hall, { eventType: 'Wedding & gala' }).some((w) => w.code === 'event_type'));
  assert.ok(V.warnings(hall, { eventType: 'political' }).some((w) => w.code === 'event_type'));
});
t('warnings: sound curfew for concert / DJ, restriction chips', () => {
  const w = V.warnings(lawn, { eventType: 'concert' });
  assert.ok(w.some((x) => x.code === 'sound_curfew' && /22:00/.test(x.msg)));
  assert.ok(w.some((x) => x.code === 'generator_required'));
  assert.ok(V.warnings(Object.assign({}, lawn, { event_types: [] }), { eventType: 'DJ night' }).some((x) => x.code === 'sound_curfew'));
  assert.ok(!V.warnings(Object.assign({}, lawn, { event_types: [] }), { eventType: 'conference' }).some((x) => x.code === 'sound_curfew'));
  assert.ok(V.warnings(hall, {}).some((x) => x.code === 'no_outside_catering'));
});
t('fillFor converts to builder feet + capacity', () => {
  const f = V.fillFor(Object.assign({ address: 'Shamshabad Road', city: 'Hyderabad', contact_name: 'Ravi', contact_phone: '+919800000000' }, lawn));
  assert.equal(f.lenFt, 262); assert.equal(f.widFt, 164); assert.equal(f.setting, 'outdoor'); assert.equal(f.capacity, 2000);
  assert.equal(f.address, 'Shamshabad Road, Hyderabad'); assert.equal(f.contact, 'Ravi / +919800000000');
});
t('cost text in lakh', () => {
  assert.equal(V.costText({ cost_min: 350000, cost_max: 600000, cost_basis: 'per_day' }), '₹3.5 L - ₹6 L per day');
});
t('pages wire the venue scripts (no inline), store-api v=157', () => {
  const cc = read('public/control.html');
  assert.match(cc, /id="tab-venues"[^>]*hidden/); assert.match(cc, /id="pane-venues" hidden/);
  assert.match(cc, /<script src="venues-core\.js\?v=2"><\/script>\s*<script src="venues-admin\.js\?v=1"><\/script>/);
  for (const p of ['flow.html', 'builder.html']) {
    const h = read('public/' + p);
    assert.match(h, /<script src="venues-core\.js\?v=2"><\/script>\s*<script src="venue-picker\.js\?v=3"><\/script>/, p);
    assert.match(h, /venues\.css\?v=2/, p);
    assert.match(h, /store-api\.js\?v=159/, p);
  }
  for (const f of ['venues-core.js', 'venue-picker.js', 'venues-admin.js']) {
    const js = read('public/' + f);
    assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML|\.style\.|style=/.test(js), f + ': DOM nodes only, no inline style');
  }
});
t('store-api: venues area + RPCs', () => {
  const s = read('public/store-api.js');
  assert.match(s, /key: "venues",/);
  assert.match(s, /rpc\("venue_save"/); assert.match(s, /rpc\("venue_set_active"/); assert.match(s, /rpc\("venue_load_samples"/);
  assert.match(s, /\.from\("venues"\)/);
});
t('SQL: additive, tenant + area gated, no delete, ASCII APPLY', () => {
  const m = read('supabase/migrations/0085_venues.sql'), a = read('supabase/APPLY-0085.sql');
  assert.ok(!/^\s*(drop table|delete from|truncate)/im.test(m));
  assert.match(m, /current_org_id\(\)\) and public\.has_area\('venues', 'view'\)/);
  assert.equal((m.match(/has_area\('venues', 'edit'\)/g) || []).length, 2);
  assert.match(m, /zz_a85_venue_no_delete/); assert.match(m, /zzz_studio_read_only/);
  assert.match(m, /set search_path = ''/);
  assert.ok(!/[^\x00-\x7e]/.test(a), 'APPLY pure ASCII');
  assert.match(a, /select item, ok from \(values/);
  assert.match(read('supabase/migrations/MANIFEST'), /forward  supabase\/migrations\/0085_venues\.sql/);
});
t('linked venue on the client JSON: flow + builder', () => {
  const f = read('public/flow.html'), b = read('public/builder.js'), pk = read('public/venue-picker.js');
  assert.match(f, /<select id="v_setting">/); assert.match(f, /id="v_venue_id"/); assert.match(f, /id="v_venue_name"/);
  assert.match(f, /venueId:vid, venueName:vnm, setting:vs/, 'saveVenue persists the link + setting');
  assert.match(f, /cl\.venueId[\s\S]{0,400}HelmVenuePicker\.sync\(\)/, 'load restores the link and re-shows warnings');
  assert.match(b, /HelmBuilderVenue[\s\S]{0,400}venueId: v\.id, venueName: v\.name/);
  assert.match(read('public/builder.html'), /builder\.js\?v=34/);
  assert.match(pk, /Linked to saved venue: /); assert.match(pk, /text: "change"/); assert.match(pk, /text: "unlink"/);
});
console.log('venues: ok (' + n + ')');
