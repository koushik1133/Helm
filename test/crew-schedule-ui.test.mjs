// Crew schedule calendar (0161): SQL static guards + calendar / staff / store wiring + block grouping.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const r = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0; const t = (m, f) => { f(); n++; console.log('ok - ' + m); };
const SQL = 'supabase/migrations/0161_crew_schedule.sql';

t('0161: ASCII, additive (no drop/delete/truncate/alter table), ends with VERIFY, in MANIFEST', () => {
  const s = r(SQL);
  assert.ok(/^[\x00-\x7F]*$/.test(s), 'ascii');
  assert.doesNotMatch(s, /\b(drop|delete|truncate|insert|update)\b/i);
  assert.doesNotMatch(s, /alter\s+table/i);
  assert.match(s.trimEnd(), /select item, ok from \(values[\s\S]*\) v\(item, ok\) order by item;$/);
  assert.match(r('supabase/migrations/MANIFEST'), /forward\s+supabase\/migrations\/0161_crew_schedule\.sql/);
  assert.ok(r('scripts/db-test/run-all.sh').includes('tests/db/crew-schedule-0161.sql'));
});

t('0161: definer RPC, pinned search_path, org-scoped, own rows for crew, team for staff/calendar viewers', () => {
  const s = r(SQL);
  assert.match(s, /function public\.crew_schedule\(p_from date, p_to date, p_staff uuid default null\)/);
  assert.match(s, /security definer set search_path = ''/);
  assert.match(s, /v_org uuid := public\.current_org_id\(\)/);
  for (const tb of ['cm.org_id = v_org', 'q.org_id = v_org', 't.org_id = v_org']) assert.ok(s.includes(tb), tb);
  assert.match(s, /has_area\('staff', 'view'\) or public\.has_area\('calendar', 'view'\)/);
  assert.match(s, /not in \('crew', 'worker'\)/);
  assert.match(s, /t\.crew_id in \(select public\._a153_my_crew_ids\(\)\)/);
  assert.match(s, /p_to - p_from > 62/);
  assert.match(s, /revoke all on function public\.crew_schedule\(date, date, uuid\) from public/);
  assert.match(s, /revoke all on function public\.crew_schedule\(date, date, uuid\) from anon/);
  assert.match(s, /grant execute on function public\.crew_schedule\(date, date, uuid\) to authenticated/);
});

t('0161: returns schedule fields only - no money, no client contact', () => {
  const s = r(SQL);
  const ret = s.slice(s.indexOf('returns table ('), s.indexOf('language plpgsql'));
  assert.doesNotMatch(ret, /price|total|amount|pricing|client|phone|email|contact|rate/i);
  const body = s.slice(s.indexOf('return query'), s.indexOf('end $$;'));
  assert.doesNotMatch(body, /q\.client|q\.pricing|venue_contact|cm\.phone|cm\.email|day_rate/);
});

t('store: BPStore.ops.crew.schedule calls crew_schedule; store-api bumped everywhere', () => {
  const s = r('public/store-api.js');
  assert.match(s, /schedule: \(from, to, staffId\) => \(supa \? rpc\("crew_schedule", \{ p_from: from, p_to: to, p_staff: staffId \|\| null \}\)/);
  for (const p of ['calendar.html', 'staff.html', 'dashboard.html']) assert.match(r('public/' + p), /store-api\.js\?v=271/, p);
});

t('calendar: schedule section, assets, crew vs team mode, deep link from staff', () => {
  const h = r('public/calendar.html');
  assert.match(h, /<section id="schedule" class="csched" hidden aria-labelledby="schedTitle"><\/section>/);
  assert.match(h, /crew-schedule\.css\?v=4/); assert.match(h, /<script src="crew-schedule\.js\?v=6"><\/script>/);
  assert.match(h, /crewOnly=role==="crew"\|\|role==="worker"/);
  assert.match(h, /HelmCrewSchedule\.mount\(el,\{ team, staff:team\?\(sp\.get\("staff"\)\|\|""\):""/);
  assert.match(h, /crewOnly\?"runsheet\.html\?id=":"event\.html\?id="/);
  assert.match(r('public/staff.html'), /href="calendar\.html\?staff=\$\{encodeURIComponent\(s\.id\)\}#schedule"[^>]*>Schedule<\/a>/);
  assert.match(r('public/shell-b.js'), /\["calendar", "Calendar", "calendar\.html", "calendar"\]/);   // crew nav: Calendar (crew have calendar view, 0143)
});

t('crew-schedule.js: Apple-style Day / Week / Month, time grid, now line, popover, team grid, mobile css', () => {
  const js = r('public/crew-schedule.js'), css = r('public/crew-schedule.css');
  for (const k of ['Team schedule', 'My schedule', 'All crew', 'data-v="day"', 'data-v="week"', 'data-v="month"', 'cs-grid', 'cs-month', 'cs-tg', 'cs-now', 'cs-pop', 'all-day', 'Open event', 'Today']) assert.ok(js.includes(k), k);
  assert.match(js, /narrow\(\) \? 3 : 7/);   // week -> 3-day on phones, team grid too (cal-1018)
  assert.match(js, /cs-s-' \+ k/); assert.match(js, /statusFor\(b\.quote_id\)/); // chip colour by status
  assert.doesNotMatch(js, / style="/);                                            // CSP: positions via data-st + CSSOM
  assert.match(css, /\.cs-s-confirmed\{--cs-c:/); assert.match(css, /\.cs-s-lead\{--cs-c:/);
  assert.match(css, /\.cs-pop\.cs-sheet\{position:fixed/);
  assert.match(css, /\.cs-gridwrap\{overflow-x:auto/);
  const h = r('public/calendar.html');
  assert.match(h, /statusFor:\(qid\)=>/); assert.match(h, /extra:\(\)=>leadDates\.map/); assert.match(h, /schedUI\.refresh\(\)/);
});

t('work status words + overlap lanes', () => {
  const ctx = { window: {}, console }; vm.createContext(ctx); vm.runInContext(r('public/crew-schedule.js'), ctx);
  const C = ctx.window.HelmCrewSchedule;
  assert.equal(C._workOf('open').l, 'Not started'); assert.equal(C._workOf('in_progress').l, 'In progress'); assert.equal(C._workOf('done').l, 'Done');
  const L = C._lanes([{ start: 0, end: 10 }, { start: 5, end: 15 }, { start: 20, end: 30 }]);
  assert.equal(L[0]._cols, 2); assert.equal(L[1]._col, 1); assert.equal(L[2]._cols, 1);
});

t('grouping: one block per person+event+day, start-end time, start only, event time fallback', () => {
  const ctx = { window: {}, console }; vm.createContext(ctx); vm.runInContext(r('public/crew-schedule.js'), ctx);
  const C = ctx.window.HelmCrewSchedule;
  const s = new Date(2026, 10, 10, 18, 0).toISOString(), e = new Date(2026, 10, 10, 23, 30).toISOString();
  assert.equal(C._timeOf({ planned_start: s, planned_end: e }), '18:00–23:30');
  assert.equal(C._timeOf({ planned_start: s }), '18:00');
  assert.equal(C._timeOf({ event_time: '19:00' }), '19:00');
  assert.equal(C._timeOf({}), '');
  assert.equal(C._dayOf({ event_date: '2026-11-12' }), '2026-11-12');
  assert.equal(C._dayOf({ planned_start: s, event_date: '2026-11-12' }), '2026-11-10');
  const g = C._group([
    { crew_id: 'c1', crew_name: 'A', quote_id: 'q1', event_title: 'Wedding', planned_start: s, planned_end: e, task_title: 'Captain' },
    { crew_id: 'c1', crew_name: 'A', quote_id: 'q1', event_title: 'Wedding', event_date: '2026-11-10', task_title: 'Setup' },
    { crew_id: 'c2', crew_name: 'B', quote_id: 'q1', event_title: 'Wedding', event_date: '2026-11-10', event_time: '17:00', task_title: 'Waiter' },
  ]);
  assert.equal(g.length, 2); assert.equal(g[0].shifts.length, 2); assert.equal(g[0].time, '18:00–23:30');
  assert.equal(g[1].time, '17:00');
});
t('verify-166: staff Schedule link only for roles that can open the calendar', () => {
  const SH = r('public/staff.html');
  assert.match(SH, /canCal=await BPStore\.auth\.canView\("calendar"\)/);
  assert.match(SH, /\$\{canCal\?`<a class="ic" href="calendar\.html\?staff=/);
});
console.log(n + ' passed');
