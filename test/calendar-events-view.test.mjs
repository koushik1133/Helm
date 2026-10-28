// cal-events-1018: Calendar page "Events | Team" switch + the Events calendar (which event is on when).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const r = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0; const t = (m, f) => { f(); n++; console.log('ok - ' + m); };
const CAL = r('public/calendar.html'), JS = r('public/events-calendar.js'), CSS = r('public/events-calendar.css'), S = r('public/store-api.js');

t('calendar.html: Events | Team tabs at the top (tablist, aria-selected / aria-controls), Events first + default', () => {
  assert.match(CAL, /<div class="cv-tabs" role="tablist" aria-label="Calendar view">/);
  assert.match(CAL, /role="tab" id="cvTabEvents" data-cv="events" aria-controls="cvEvents" aria-selected="true">Events</);
  assert.match(CAL, /role="tab" id="cvTabTeam" data-cv="team" aria-controls="cvTeam" aria-selected="false" tabindex="-1">Team</);
  assert.ok(CAL.indexOf('id="cvBar"') < CAL.indexOf('id="conflictsH"'), 'switch sits above the conflicts / agenda');
  assert.match(CAL, /<div id="cvEvents" role="tabpanel" aria-labelledby="cvTabEvents" hidden><section id="evcal" class="evc" aria-labelledby="evcTitle"><\/section><\/div>/);
  assert.match(CAL, /<div id="cvTeam" role="tabpanel" aria-labelledby="cvTabTeam">\s*<section id="schedule" class="csched" hidden aria-labelledby="schedTitle"><\/section>/);
  assert.match(CAL, /\(prefGet\("View"\)\|\|"events"\)/, 'default view = Events');
});

t('calendar.html: view remembered per user (key carries the user id), ?cv= / crew deep link pick the view, arrows switch tabs', () => {
  assert.match(CAL, /const prefKey=\(k\)=>"helm\.cal"\+k\+"\."\+\(\(\(BPStore\.auth\.user&&BPStore\.auth\.user\(\)\)\|\|\{\}\)\.id\|\|"local"\)/);
  assert.match(CAL, /q==="team"\|\|q==="events"\?q:\(sp\.get\("staff"\)\|\|location\.hash==="#schedule"\)\?"team"/);
  assert.match(CAL, /\["ArrowLeft","ArrowRight","Home","End"\]\.includes\(k\)/);
  assert.match(CAL, /prefSet\("View",t\.dataset\.cv\)/);
});

t('calendar.html: crew (no quotes) get only their schedule; team schedule mounts lazily on first Team view', () => {
  assert.match(CAL, /cvEventsOk=!!\(canQuotes&&!crewOnly&&window\.HelmEventsCalendar\)/);
  assert.match(CAL, /\$\("#cvBar"\)\.hidden=!\(cvEventsOk&&cvTeamOk\)/);
  assert.match(CAL, /if\(v==="events"\) mountEvents\(\); else if\(!schedUI\) mountSchedule\(\);/);
  assert.doesNotMatch(CAL, /\n\s*mountSchedule\(\);\n\s*await load\(\);/, 'no eager schedule mount at boot');
});

t('calendar.html: items = dated, not-cancelled events (confirmed / tentative) + open leads; Sample + clash + venue + guests; studio today', () => {
  assert.match(CAL, /if\(st==="cancelled"\) return;/);
  assert.match(CAL, /kind:st==="confirmed"\?"confirmed":"tentative"/);
  assert.match(CAL, /sample:sampleIds\.has\(e\.id\)\|\|SAMPLE_RE\.test\(e\.title\|\|""\), clash:clashIds\.has\(e\.id\)/);
  assert.match(CAL, /kind:"lead"[\s\S]{0,260}sample:l\.is_demo===true/);
  assert.match(CAL, /venue:a\.venue\|\|\(e\.client&&e\.client\.venue\)\|\|"", guests:e\.guests/);
  assert.match(CAL, /if\(acks\[c\.key\]\) return;/, 'acknowledged clashes do not badge');
  assert.match(CAL, /BPStore\.studioTimezone&&BPStore\.studioTimezone\(\); return new Intl\.DateTimeFormat\("en-CA",\{timeZone:tz\|\|undefined/);
  assert.match(CAL, /fmt:\(d,o\)=>BPStore\.fmtStudioDate\(d,\{fmt:o\}\)/);
  assert.match(CAL, /kinds:canLeads\?\["confirmed","tentative","lead"\]:\["confirmed","tentative"\]/);
  assert.match(CAL, /<h2 id="conflictsH">Conflicts<\/h2>/);
});

t('assets pinned: events-calendar.css / .js, store-api bumped', () => {
  assert.match(CAL, /<link rel="stylesheet" href="events-calendar\.css\?v=\d+">/);
  assert.match(CAL, /<script src="events-calendar\.js\?v=\d+"><\/script>/);
  assert.match(CAL, /store-api\.js\?v=299/);
});

t('events-calendar.js: month / week / day, "+N more", today, clash badge, legend filter, type filter, phone agenda, hover card', () => {
  for (const k of ['function monthView', 'function weekView', 'function dayView', 'function agendaView', '" more</button>', 'aria-current="date"',
    'class="evc-clash" href="#conflictsH"', 'aria-pressed="true"', 'id="evcType"', '(max-width: 600px)', 'role", "tooltip"', 'evc-sample">Sample<'])
    assert.ok(JS.includes(k), k);
  assert.match(JS, /var max = 3/);
  // keyboard: roving tabindex across day numbers, arrows / Home / End, Escape closes the hover card
  assert.match(JS, /tabindex="' \+ \(d === focus \? "0" : "-1"\)/);
  assert.match(JS, /\{ ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 \}/);
  assert.match(JS, /e\.key === "Escape" && tip && !tip\.hidden/);
  // a range picked from the Month / Week / Day switch is remembered; opening one day is not
  assert.match(JS, /go\(to, null, true\)/);
  assert.match(JS, /if \(persist && opts\.onView\)/);
});

t('events-calendar.js: CSP-safe + escaped (no inline style attributes / handlers; user text through esc or textContent)', () => {
  assert.doesNotMatch(JS, /style="/);
  assert.doesNotMatch(JS, /\son[a-z]+="/);
  assert.doesNotMatch(JS, /innerHTML\s*=\s*[^;]*it\.(title|venue|type|code)(?![^;]*esc\()/);
  assert.match(JS, /b\.textContent = it\.title/);
});

t('events-calendar.js helpers: UTC day maths, multi-day expansion (capped at 31 days), month ends', () => {
  const win = {}; vm.runInNewContext(JS, { window: win, document: {} });
  const H = win.HelmEventsCalendar;
  assert.equal(H._add('2026-10-31', 1), '2026-11-01');
  assert.equal(H._add('2026-03-29', 1), '2026-03-30');
  assert.equal(H._monday('2026-10-18'), '2026-10-12');
  assert.equal(H._monday('2026-10-19'), '2026-10-19');
  assert.equal(H._lastOf('2028-02-10'), '2028-02-29');
  assert.equal(H._addMonths('2026-12-15', 1), '2027-01-01');
  const rows = H._expand([{ key: 'a', kind: 'confirmed', date: '2026-10-30', end: '2026-11-01' }, { key: 'b', kind: 'lead', date: '2026-10-18' },
    { key: 'c', kind: 'tentative', date: 'bad' }, { key: 'd', kind: 'confirmed', date: '2026-10-01', end: '2027-01-01' }, { key: 'e', kind: 'confirmed', date: '2026-10-05', end: '2026-10-01' }]);
  const a = rows.filter((x) => x.it.key === 'a');
  assert.deepEqual(JSON.parse(JSON.stringify(a.map((x) => [x.day, x.n, x.of]))), [['2026-10-30', 1, 3], ['2026-10-31', 2, 3], ['2026-11-01', 3, 3]]);
  assert.equal(rows.filter((x) => x.it.key === 'b').length, 1);
  assert.equal(rows.filter((x) => x.it.key === 'c').length, 0, 'invalid date skipped');
  assert.equal(rows.filter((x) => x.it.key === 'd').length, 31, 'capped');
  assert.equal(rows.filter((x) => x.it.key === 'e').length, 1, 'end before start = one day');
});

t('events-calendar.css: green tokens, status colours match the team schedule, phone layout, focus rings', () => {
  assert.match(CSS, /--evc-conf:var\(--accent,#047857\);--evc-tent:#c27c0e;--evc-lead:#5b5bd6/);
  assert.match(CSS, /\.cv-tabs \[role=tab\]\[aria-selected=true\]\{background:var\(--accent/);
  assert.match(CSS, /\.evc-today \.evc-num\{background:var\(--accent\);color:#fff\}/);
  assert.match(CSS, /@media\(max-width:600px\)/);
  assert.match(CSS, /\.evc :is\(button,a,select\):focus-visible\{outline:2px solid var\(--accent\)/);
});

t('store-api: guest count on list rows (number only), event_plan venue on the agenda, sample (is_demo) quote ids', () => {
  assert.match(S, /"pricing_guests:pricing->guests,client_guests:client->>guests";/);
  assert.match(S, /guests: listGuests\(q\.pricing_guests, q\.client_guests, pricing\.guests, q\.client && q\.client\.guests\)/);
  assert.match(S, /staffCount: crew\.length, venue: venueOf\(e\)\.name,/);
  assert.match(S, /async sampleIds\(\) \{\n\s*if \(mode !== "supabase" \|\| !supa\) return \[\];[\s\S]{0,200}\.from\("quotes"\)\.select\("id"\)\.eq\("is_demo", true\)\.limit\(500\)/);
  const src = /const listGuests = [^\n]*\n/.exec(S)[0]; const ctx = {}; vm.runInNewContext(src + 'this.f = listGuests;', ctx);
  assert.equal(ctx.f(null, '250'), 250); assert.equal(ctx.f('', 0, 'x', 80.4), 80); assert.equal(ctx.f(null, undefined), null); assert.equal(ctx.f(-5, 12), 12);
});

t('dashboard: the existing "Your month" calendar card is reused (no duplicate "This week\'s events" card)', () => {
  const D = r('public/shell-b-dash.js');
  assert.match(D, /card\("hdCal", "Your month", IC\.cal, \{ skel: 4, more: \["calendar\.html", "Calendar"\]/);
  assert.doesNotMatch(D, /This week's events/);
});

console.log(`\ncalendar-events-view: ${n} passed`);
