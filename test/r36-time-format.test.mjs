// R36: PM times showed as AM. HelmCountry.formatTime (and 7 copies of the same idea) matched only "H:MM"
// and dropped the rest, so "6:30 PM" became hour 6 = "6:30 AM" (invitation guests saw "4:00 AM" for "4:00 PM").
// One parser now lives in country-profile.js (parseTime / toHHMM / formatTime); every caller goes through it.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('  ✓ ' + name); };
const H = require('../public/country-profile.js');

// [input, formatTime (client label), toHHMM (24h)]   "" = not a time
const TABLE = [
  // 24h, as <input type="time"> and Postgres store it
  ['18:30', '6:30 PM', '18:30'], ['06:30', '6:30 AM', '06:30'], ['6:30', '6:30 AM', '06:30'],
  ['00:00', '12:00 AM', '00:00'], ['00:30', '12:30 AM', '00:30'], ['12:00', '12:00 PM', '12:00'], ['12:05', '12:05 PM', '12:05'],
  ['13:00', '1:00 PM', '13:00'], ['23:59', '11:59 PM', '23:59'], ['19:00:00', '7:00 PM', '19:00'],
  ['18:30:00.000', '6:30 PM', '18:30'], ['18:30:00+05:30', '6:30 PM', '18:30'], [' 18:30 ', '6:30 PM', '18:30'],
  // 12h, as studios type it / as older rows hold it
  ['6:30 PM', '6:30 PM', '18:30'], ['6:30 pm', '6:30 PM', '18:30'], ['6:30pm', '6:30 PM', '18:30'], ['6:30PM', '6:30 PM', '18:30'],
  ['06:30 p.m.', '6:30 PM', '18:30'], ['6:30 P.M.', '6:30 PM', '18:30'], ['6:30 p.m', '6:30 PM', '18:30'], ['6:30 p m', '6:30 PM', '18:30'],
  ['4:00 PM', '4:00 PM', '16:00'], ['7:05 a.m.', '7:05 AM', '07:05'], ['9:15 AM', '9:15 AM', '09:15'], ['11:59 pm', '11:59 PM', '23:59'],
  ['6 PM', '6:00 PM', '18:00'], ['6pm', '6:00 PM', '18:00'], ['6.30 pm', '6:30 PM', '18:30'],
  ['6:30 PM', '6:30 PM', '18:30'], ['6:30 PM', '6:30 PM', '18:30'],          // Intl output uses narrow/no-break spaces
  // 12 AM / 12 PM edges
  ['12:00 AM', '12:00 AM', '00:00'], ['12:30 am', '12:30 AM', '00:30'], ['12:00 PM', '12:00 PM', '12:00'], ['12:45 p.m.', '12:45 PM', '12:45'],
  ['12 AM', '12:00 AM', '00:00'], ['12 PM', '12:00 PM', '12:00'], ['1:00 AM', '1:00 AM', '01:00'], ['1:00 PM', '1:00 PM', '13:00'],
  // a 24h hour with a redundant PM is still that hour
  ['18:30 PM', '6:30 PM', '18:30'],
  // not a time -> "" (never a guessed AM)
  ['', '', ''], [null, '', ''], [undefined, '', ''], ['abc', '', ''], ['6', '', ''], ['18', '', ''], ['2026-10-27', '', ''],
  ['24:00', '', ''], ['25:00', '', ''], ['6:60 PM', '', ''], ['18:75', '', ''], ['6:3 PM', '', ''],
  ['13:00 AM', '', ''], ['0:30 AM', '', ''], ['00:00 PM', '', ''], [{}, '', ''],
];

t('HelmCountry.formatTime + toHHMM: full input table (' + TABLE.length + ' rows)', () => {
  for (const [inp, label, hhmm] of TABLE) {
    assert.equal(H.formatTime(inp), label, 'formatTime(' + JSON.stringify(inp) + ')');
    assert.equal(H.toHHMM(inp), hhmm, 'toHHMM(' + JSON.stringify(inp) + ')');
    const p = H.parseTime(inp);
    if (hhmm) assert.equal(String(p.h).padStart(2, '0') + ':' + String(p.m).padStart(2, '0'), hhmm); else assert.equal(p, null);
  }
});

t('the reported bug: 6:30 PM / 4:00 PM never come back as AM', () => {
  assert.equal(H.formatTime('6:30 PM'), '6:30 PM'); assert.equal(H.formatTime('4:00 PM'), '4:00 PM');
  for (let h = 1; h <= 12; h++) for (const mi of ['00', '30']) {
    const want = h + ':' + mi + ' PM';
    for (const s of [h + ':' + mi + ' PM', h + ':' + mi + 'pm', String(h).padStart(2, '0') + ':' + mi + ' p.m.']) assert.equal(H.formatTime(s), want, s);
    const wantA = h + ':' + mi + ' AM';
    for (const s of [h + ':' + mi + ' AM', h + ':' + mi + 'am', String(h).padStart(2, '0') + ':' + mi + ' a.m.']) assert.equal(H.formatTime(s), wantA, s);
  }
  for (let h = 0; h < 24; h++) assert.equal(H.formatTime(H.formatTime(String(h).padStart(2, '0') + ':15')), H.formatTime(String(h).padStart(2, '0') + ':15'), 'round-trip ' + h);
});

t('formatEventDate in each country style (IN / AE / US), 24h and 12h input agree', () => {
  const D = '2026-12-28';
  const want = { IN: 'Monday, 28 December 2026 · 6:30 PM', AE: 'Monday, 28 December 2026 · 6:30 PM', US: 'Monday, December 28, 2026 · 6:30 PM' };
  for (const cc of ['IN', 'AE', 'US']) for (const tm of ['18:30', '18:30:00', '6:30 PM', '6:30pm', '06:30 p.m.']) assert.equal(H.formatEventDate(cc, D, tm), want[cc], cc + ' ' + tm);
  for (const cc of ['IN', 'AE', 'US']) {
    assert.match(H.formatEventDate(cc, D, '12:00 AM'), / · 12:00 AM$/); assert.match(H.formatEventDate(cc, D, '12:00 PM'), / · 12:00 PM$/);
    assert.match(H.formatEventDate(cc, D, '00:00'), / · 12:00 AM$/); assert.match(H.formatEventDate(cc, D, '12:00'), / · 12:00 PM$/);
    assert.equal(H.formatEventDate(cc, D, 'soon'), H.formatDate(cc, D));          // junk time -> date only, no fake AM
  }
  assert.equal(H.formatEventDate('US', D, '4:00 PM', { weekday: false }), 'December 28, 2026 · 4:00 PM');
});

t('invitation + portal + invite studio all go through HelmCountry (the live bug site)', () => {
  assert.match(read('public/invite.html'), /function fmtTime\(t\)\{ const HC=window\.HelmCountry; return \(HC&&HC\.formatTime&&HC\.formatTime\(t\)\)\|\|String\(t\|\|""\); \}/);
  assert.match(read('public/portal.html'), /HC\.formatEventDate\(cc,String\(d\),t\)/);
  assert.match(read('public/invite-studio.html'), /HC&&HC\.formatTime\(tm\)/);
});

// --- booklet.js fmtTime (client booklet) -------------------------------------------------
function loadBooklet(withHC) {
  const ctx = { console, URLSearchParams }; ctx.window = ctx; ctx.globalThis = ctx; if (withHC) ctx.HelmCountry = H;
  vm.createContext(ctx); vm.runInContext(read('public/booklet.js'), ctx); return ctx.HelmBooklet;
}
t('booklet fmtTime: 12h input keeps PM; without HelmCountry a 12h string is shown as typed, never as AM', () => {
  const B = loadBooklet(true); B.setFormat('en-US', 'USD');
  const norm = (s) => s.replace(/[  ]/g, ' ');
  for (const s of ['18:30', '6:30 PM', '6:30pm', '06:30 p.m.']) assert.equal(norm(B.fmtTime(s)), '6:30 PM', s);
  assert.equal(norm(B.fmtTime('12:00 AM')), '12:00 AM'); assert.equal(norm(B.fmtTime('12:00 PM')), '12:00 PM');
  assert.equal(norm(B.fmtTime('00:15')), '12:15 AM'); assert.equal(B.fmtTime('whenever'), 'whenever'); assert.equal(B.fmtTime(''), '');
  const B0 = loadBooklet(false); B0.setFormat('en-US', 'USD');
  assert.equal(norm(B0.fmtTime('18:30')), '6:30 PM'); assert.equal(B0.fmtTime('6:30 PM'), '6:30 PM'); assert.equal(B0.fmtTime('6:30pm'), '6:30pm');
});

// --- event.html (inline) evTimeLabel / evTimeInput ----------------------------------------
const EV = read('public/event.html');
const fnSrc = (src, name) => { const s = src.indexOf('function ' + name + '('); assert.ok(s >= 0, name); let i = src.indexOf('{', s), d = 0;
  for (; i < src.length; i++) { if (src[i] === '{') d++; else if (src[i] === '}') { d--; if (d === 0) break; } } return src.slice(s, i + 1); };
const evFn = (name, ctx) => vm.runInNewContext('(' + fnSrc(EV, name).replace(new RegExp('^function ' + name), 'function') + ')', ctx);
t('event page: label + time box read "6:30 PM" as 18:30 (with HelmCountry); fallback never invents AM', () => {
  const evParseTime = evFn('evParseTime', { HelmCountry: H });
  const lbl = evFn('evTimeLabel', { evParseTime }), box = evFn('evTimeInput', { evParseTime });
  for (const s of ['18:30', '6:30 PM', '6:30pm', '06:30 p.m.']) { assert.equal(lbl(s), '6:30 pm', s); assert.equal(box(s), '18:30', s); }
  assert.equal(lbl('12:00 AM'), '12:00 am'); assert.equal(box('12:00 AM'), '00:00'); assert.equal(lbl('12:00 PM'), '12:00 pm'); assert.equal(box('12:00 PM'), '12:00');
  const fb = evFn('evParseTime', {});
  const lbl0 = evFn('evTimeLabel', { evParseTime: fb }), box0 = evFn('evTimeInput', { evParseTime: fb });
  assert.equal(lbl0('19:00:00'), '7:00 pm'); assert.equal(box0('9:05'), '09:05');
  assert.equal(lbl0('6:30 PM'), '6:30 PM'); assert.equal(box0('6:30 PM'), '');
});

// --- the other callers that had the same H:MM-only match ----------------------------------
t('dashboard countdown + agenda, calendar, venue-clash maths all parse through HelmCountry', () => {
  const D = read('public/shell-b-dash.js');
  assert.match(D, /function parseHM\(t\) \{\n    var HC = window\.HelmCountry; if \(HC && HC\.parseTime\) return HC\.parseTime\(t\);/);
  assert.match(D, /var tm = ev\.time && parseHM\(ev\.time\);/); assert.match(D, /if \(tm\) target\.setHours\(tm\.h, tm\.m, 0, 0\);/);
  assert.match(D, /function hhmm\(t\) \{ var p = t && parseHM\(t\);/);
  const parseHM = vm.runInNewContext('(' + fnSrc(D, 'parseHM').replace(/^function parseHM/, 'function') + ')', { window: { HelmCountry: H } });
  assert.deepEqual({ ...parseHM('6:30 PM') }, { h: 18, m: 30 });
  const parseHM0 = vm.runInNewContext('(' + fnSrc(D, 'parseHM').replace(/^function parseHM/, 'function') + ')', { window: {} });
  assert.equal(parseHM0('6:30 PM'), null); assert.deepEqual({ ...parseHM0('18:30') }, { h: 18, m: 30 });

  const C = read('public/events-calendar.js');
  assert.match(C, /var HC = window\.HelmCountry; if \(HC && HC\.toHHMM\) return HC\.toHHMM\(t\);/);

  const S = read('public/store-api.js');
  const i = S.indexOf('const toMin = (t) =>'); assert.ok(i > 0); const j = S.indexOf('};', i) + 2;
  const toMin = vm.runInNewContext('(function(){ ' + S.slice(i, j) + ' return toMin; })()', { window: { HelmCountry: H } });
  assert.equal(toMin('6:30 PM'), 18 * 60 + 30); assert.equal(toMin('18:30'), 18 * 60 + 30); assert.equal(toMin('12:00 AM'), 0); assert.equal(toMin('x'), null);
});

t('delivery "new expected time" prompt: "5:30 pm truck stuck" is 17:30 + reason "truck stuck"', () => {
  const T = read('public/delivery-tracker.js');
  const re = /var m = (\/\^.*?\/i)\.exec\(String\(ans\)\)/.exec(T); assert.ok(re, 'prompt regex');
  const parse = (ans) => { const R = vm.runInNewContext(re[1]); let m = R.exec(String(ans)), H = m ? +m[1] : -1;
    if (m && m[3]) { const pm = m[3].toLowerCase() === 'p'; H = H < 1 || H > 12 ? -1 : (H % 12) + (pm ? 12 : 0); }
    if (m && (H < 0 || H > 23 || +m[2] > 59)) m = null; return m ? [('0' + H).slice(-2) + ':' + m[2], m[4]] : null; };
  assert.match(T, /if \(m && m\[3\]\) \{ var pm = m\[3\]\.toLowerCase\(\) === "p"; H = H < 1 \|\| H > 12 \? -1 : \(H % 12\) \+ \(pm \? 12 : 0\); \}/);
  assert.match(T, /note = m\[4\] \|\| null;/);
  assert.deepEqual(parse('17:30 truck stuck'), ['17:30', 'truck stuck']);
  assert.deepEqual(parse('5:30 pm truck stuck'), ['17:30', 'truck stuck']);
  assert.deepEqual(parse('5:30PM'), ['17:30', '']); assert.deepEqual(parse('12:15 a.m. late'), ['00:15', 'late']);
  assert.deepEqual(parse('12:15 pm'), ['12:15', '']); assert.equal(parse('25:00 x'), null); assert.equal(parse('13:00 am'), null);
  assert.deepEqual(parse('5:30 pmx'), ['05:30', 'pmx']);   // not a meridiem -> left in the reason, as before
});

t('resources: vendor-request time box reads "06:30 PM" as 18:30 (country-profile loaded first)', () => {
  const R = read('public/resources.html');
  const line = /\$\("#vr_time"\)\.value=(\(window\.HelmCountry && HelmCountry\.toHHMM\(ev && ev\.eventTime\)\) \|\| "10:00");/.exec(R);
  assert.ok(line, 'vr_time uses HelmCountry.toHHMM');
  assert.doesNotMatch(R, /\/\^\\d\{2\}:\\d\{2\}\/\.test\(ev\.eventTime/);
  assert.ok(R.indexOf('country-profile.js?v=') > 0 && R.indexOf('country-profile.js?v=') < R.indexOf('$("#vr_time")'), 'country-profile.js loaded before use');
  const box = (ev, win) => vm.runInNewContext(line[1], { window: win, HelmCountry: win.HelmCountry, ev });
  const W = { HelmCountry: H };
  for (const [tm, want] of [['06:30 PM', '18:30'], ['6:30pm', '18:30'], ['06:30 p.m.', '18:30'], ['18:30:00', '18:30'], ['12:00 AM', '00:00'], ['12:00 PM', '12:00'], ['09:15', '09:15']])
    assert.equal(box({ eventTime: tm }, W), want, tm);
  assert.equal(box({ eventTime: '' }, W), '10:00'); assert.equal(box({ eventTime: 'tbd' }, W), '10:00');
  assert.equal(box(null, W), '10:00'); assert.equal(box({ eventTime: '18:30' }, {}), '10:00');
});

t('no H:MM-only time match left in the fixed formatters', () => {
  const bare = /\/\^\(\\d\{1,2\}\):\(\\d\{2\}\)\/\.exec/;
  for (const f of ['public/country-profile.js', 'public/booklet.js', 'public/shell-b-dash.js', 'public/events-calendar.js', 'public/store-api.js']) assert.doesNotMatch(read(f), bare, f);
  assert.doesNotMatch(EV, bare, 'event.html');
});

console.log('r36-time-format: ' + n + '/' + n + ' passed');
