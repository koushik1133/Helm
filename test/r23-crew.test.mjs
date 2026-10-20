// r23 crew (migration 0265): crew availability, open shifts with one-tap claim, event-day self check-in feeding wages.
// Behaviour of the SQL: tests/db/r23-crew-0265.sql (local PG). This file checks the wiring + the pure helpers.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('ok -', name); };

const SQL = read('supabase/migrations/0265_crew_availability_shifts_checkin.sql');
const APPLY = read('supabase/APPLY-0265.sql');
const MANIFEST = read('supabase/migrations/MANIFEST');
const API = read('public/store-api.js');
const SELF = read('public/crew-self.js'), OFFICE = read('public/crew-shifts.js');
const WORK = read('public/work.html'), OPS = read('public/ops.html'), CMD = read('public/command.html');
const STAFF = read('public/staff.html'), CC = read('public/control.html'), SPLIT = read('public/control-split.js');

await t('migration: in MANIFEST, ASCII only, marker, additive (no drop table / delete from / truncate)', () => {
  assert.match(MANIFEST, /forward\s+supabase\/migrations\/0265_crew_availability_shifts_checkin\.sql/);
  assert.ok(!/[^\x00-\x7f]/.test(SQL), 'ASCII only');
  assert.ok(SQL.includes('r23-crew-0265'));
  assert.ok(!/\bdrop\s+table\b|\bdelete\s+from\b|\btruncate\b/i.test(SQL));
  assert.ok(APPLY.includes('begin;') && APPLY.includes('commit;') && /-- VERIFY/.test(APPLY));
});

await t('migration: crew link RPCs go through _work_token_live; office RPCs check has_area', () => {
  for (const fn of ['crew_link_home', 'crew_set_availability', 'crew_claim_shift', 'crew_withdraw_claim', 'crew_check']) {
    const m = SQL.match(new RegExp('create or replace function public\\.' + fn + '\\([\\s\\S]*?end \\$\\$;'));
    assert.ok(m, fn); assert.ok(m[0].includes('_work_token_live(p_token)'), fn + ' token gate');
  }
  for (const fn of ['open_shift_post', 'open_shift_decide', 'open_shift_set_status', 'crew_availability_set', 'crew_checkin_office_set', 'set_crew_settings']) {
    const m = SQL.match(new RegExp('create or replace function public\\.' + fn + '\\([\\s\\S]*?end \\$\\$;'));
    assert.ok(m, fn); assert.ok(/has_area\('(staff|command|controls)', 'edit'\)/.test(m[0]), fn + ' edit gate');
  }
  assert.ok(SQL.includes("for update"), 'claims lock the shift row');
  assert.ok(!/in_lat|in_lng|out_lat/.test(SQL), 'coordinates never stored');
});

await t('store-api: shifts namespace + bell labels + assign warning uses availability', () => {
  for (const r of ['crew_link_home', 'crew_set_availability', 'crew_claim_shift', 'crew_withdraw_claim', 'crew_check', 'get_crew_settings',
    'set_crew_settings', 'open_shifts_for_event', 'open_shift_post', 'open_shift_set_status', 'open_shift_decide', 'event_timesheet',
    'event_checkin_site_set', 'crew_checkin_office_set', 'crew_availability_range', 'crew_availability_set', 'crew_day_status']) {
    assert.ok(API.includes('"' + r + '"'), r);
    assert.ok(SQL.includes('function public.' + r + '('), r + ' exists in SQL');
  }
  assert.ok(/shift_claim_pending:/.test(API) && /crew_late:/.test(API));
  assert.ok(/type: "unavailable"/.test(API), 'wouldClash warns on a day off');
});

await t('pages: containers + scripts wired; DOM-only modules (no innerHTML)', () => {
  assert.ok(WORK.includes('id="crewCheck"') && WORK.includes('id="crewShifts"') && WORK.includes('id="crewAvail"') && /crew-self\.js\?v=\d+/.test(WORK));
  assert.ok(OPS.includes('id="shiftCard"') && /crew-shifts\.js\?v=\d+/.test(OPS));
  assert.ok(CMD.includes('id="crewTimesheet"') && /crew-shifts\.js\?v=\d+/.test(CMD));
  assert.ok(STAFF.includes('id="crewAvailCard"') && /crew-shifts\.js\?v=\d+/.test(STAFF));
  assert.ok(CC.includes('id="crewCfgCard"') && /crew-shifts\.js\?v=\d+/.test(CC));
  assert.ok(SPLIT.includes('id==="crewCfgCard"') && SPLIT.includes('key:"crew"'));
  for (const src of [SELF, OFFICE]) { assert.ok(!/innerHTML|insertAdjacentHTML|document\.write/.test(src)); assert.ok(src.includes('data-money')); }
  assert.ok(!/localStorage|sessionStorage/.test(SELF), 'crew link keeps nothing in the browser');
});

await t('helpers: Maps link / lat,lng parsing + studio-zone time to instant', () => {
  globalThis.window = globalThis; globalThis.document = { readyState: 'complete', getElementById: () => null, addEventListener() {} };
  globalThis.location = { search: '' };
  globalThis.BPStore = { ops: { shifts: {} }, studioClock: (d) => { const x = new Date(d.getTime() + 330 * 60000);
    return { y: x.getUTCFullYear(), mo: x.getUTCMonth() + 1, d: x.getUTCDate(), h: x.getUTCHours(), mi: x.getUTCMinutes() }; } };
  require('../public/crew-shifts.js');
  const H = globalThis.HelmCrewShifts;
  assert.deepEqual(H.parseLatLng('12.9716, 77.5946'), { lat: 12.9716, lng: 77.5946 });
  assert.deepEqual(H.parseLatLng('https://www.google.com/maps/place/X/@12.9715987,77.5945627,17z'), { lat: 12.971599, lng: 77.594563 });
  assert.deepEqual(H.parseLatLng('https://maps.google.com/?q=19.0760,72.8777'), { lat: 19.076, lng: 72.8777 });
  assert.equal(H.parseLatLng('Taj Palace'), null);
  assert.equal(H.parseLatLng('95.1, 10.2'), null);
  assert.equal(H.toInstant('2026-12-12', '18:00'), '2026-12-12T12:30:00.000Z', '18:00 IST = 12:30 UTC');
  assert.equal(H.toInstant('2026-12-12', 'x'), null);
});

await t('docs: user manual section', () => {
  const D = read('docs/manual/r23-crew.md');
  assert.ok(/availability/i.test(D) && /open shift/i.test(D) && /check in/i.test(D));
});

console.log(`r23-crew: ${n} checks passed`);
