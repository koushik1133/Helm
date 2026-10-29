// R37: the STUDIO's time zone everywhere (studio Asia/Kolkata, viewer in the US). Runs every check twice, in a child
// process with TZ=America/New_York and with TZ=America/Los_Angeles (the process zone must be set before Date is used).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import vm from 'node:vm';

if (!process.env.R37_CHILD) {
  let bad = 0;
  for (const tz of ['America/New_York', 'America/Los_Angeles']) {
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], { env: { ...process.env, TZ: tz, R37_CHILD: '1' }, encoding: 'utf8' });
    process.stdout.write(`-- TZ=${tz}\n` + r.stdout + (r.stderr || ''));
    if (r.status !== 0) bad++;
  }
  if (bad) { console.log('R37 studio time zone: FAIL'); process.exit(1); }
  console.log('R37 studio time zone: ALL PASS (both US zones)');
  process.exit(0);
}

const r = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const require = createRequire(import.meta.url);
const H = require('../public/country-profile.js');
const IST = 'Asia/Kolkata';
let n = 0, failed = 0;
function t(name, fn) { try { fn(); n++; console.log('  ok ' + name); } catch (e) { failed++; console.log('  FAIL ' + name + '\n' + (e && e.stack || e)); } }

t('the process really runs in a US zone (the bug would show here)', () => {
  assert.match(Intl.DateTimeFormat().resolvedOptions().timeZone, /^America\//);
  assert.equal(new Date('2026-10-27T20:00:00Z').getDate(), 27, 'the browser day is still 27 Oct');
});

/* ------------------------------------------------------------------ the helper (country-profile.js) */
t('helper: added beside formatTime (R36 owns formatTime / parseTime; nothing rewritten)', () => {
  const src = r('public/country-profile.js');
  assert.ok(src.indexOf('function formatTime(t)') > 0 && src.indexOf('(function (H) {') > src.indexOf('return { VERSION'), 'new block after the factory');
  for (const f of ['studioZone', 'zonedParts', 'todayIn', 'wallDate', 'addDays', 'daysBetween', 'daysUntil', 'wallToInstant', 'dayStart', 'viewerZone'])
    assert.equal(typeof H[f], 'function', f);
  assert.equal(typeof H.formatTime, 'function'); assert.equal(H.formatTime('18:30'), '6:30 PM');
});
t('helper: studioZone = own zone, else country, else Asia/Kolkata (never the browser zone)', () => {
  assert.equal(H.studioZone('Asia/Dubai'), 'Asia/Dubai');
  assert.equal(H.studioZone('', 'AE'), 'Asia/Dubai');
  assert.equal(H.studioZone('Mars/Olympus', 'IN'), IST);
  assert.equal(H.studioZone(''), IST);
  assert.equal(H.studioZone(null, 'ZZ'), IST);
});
t('helper: the Indian day flips at 18:30 UTC (still 27 Oct in the US)', () => {
  assert.equal(H.todayIn(IST, new Date('2026-10-27T18:29:59Z')), '2026-10-27');
  assert.equal(H.todayIn(IST, new Date('2026-10-27T18:30:00Z')), '2026-10-28');
  assert.equal(H.todayIn('Asia/Dubai', new Date('2026-10-27T19:59:59Z')), '2026-10-27');
  assert.equal(H.todayIn('Asia/Dubai', new Date('2026-10-27T20:00:00Z')), '2026-10-28');
  const p = H.zonedParts(new Date('2026-10-27T18:30:00Z'), IST);
  assert.deepEqual([p.date, p.h, p.mi, p.wd, p.min], ['2026-10-28', 0, 0, 3, 0]);
});
t('helper: US daylight saving changes do not move the Indian day boundary', () => {
  // New York leaves DST on 1 Nov 2026 and enters it on 14 Mar 2027; Los Angeles the same days
  for (const [a, b] of [['2026-10-31', '2026-11-01'], ['2026-11-01', '2026-11-02'], ['2027-03-13', '2027-03-14'], ['2027-03-14', '2027-03-15']]) {
    assert.equal(H.todayIn(IST, new Date(a + 'T18:29:00Z')), a);
    assert.equal(H.todayIn(IST, new Date(a + 'T18:30:00Z')), b);
    assert.equal(H.dayStart(b, IST).toISOString(), a + 'T18:30:00.000Z');
  }
});
t('helper: wallToInstant reads a studio wall clock (also in a DST zone, both sides of the change)', () => {
  assert.equal(H.wallToInstant('2026-10-28', '16:00', IST).toISOString(), '2026-10-28T10:30:00.000Z');
  assert.equal(H.wallToInstant('2026-10-31', '09:00', 'America/New_York').toISOString(), '2026-10-31T13:00:00.000Z');
  assert.equal(H.wallToInstant('2026-11-02', '09:00', 'America/New_York').toISOString(), '2026-11-02T14:00:00.000Z');
  assert.equal(H.wallToInstant('bad', '09:00', IST), null);
});
t('helper: countdowns count studio days, not browser days', () => {
  const at = new Date('2026-10-27T20:00:00Z');   // 28 Oct 01:30 IST; 27 Oct in New York / Los Angeles
  assert.equal(H.daysUntil('2026-10-28', IST, at), 0, 'the event is TODAY in the studio');
  assert.equal(H.daysUntil('2026-10-30', IST, at), 2);
  assert.equal(H.daysUntil('2026-10-27', IST, at), -1);
  assert.equal(H.addDays('2026-10-31', 1), '2026-11-01'); assert.equal(H.addDays('2027-03-14', 1), '2027-03-15');
  assert.equal(H.daysBetween('2026-10-28', '2026-11-03'), 6);
  const w = H.wallDate(IST, at);
  assert.deepEqual([w.getFullYear(), w.getMonth(), w.getDate(), w.getHours(), w.getMinutes()], [2026, 9, 28, 1, 30]);
});

/* ------------------------------------------------------------------ BPStore (store-api.js) */
const store = r('public/store-api.js');
function pick(name) { const s = store.indexOf('BPStore.' + name + ' = function'); assert.ok(s > 0, name); const e = store.indexOf('\n  };\n', s); return store.slice(s, e + 5); }
function mkStore(tz, extra) {
  const ctx = { BPStore: { _studioTz: tz || null, studioTax: () => ({}) }, Intl, Date, isNaN, localStorage: { getItem: () => null, setItem() {} }, window: { HelmCountry: H }, ...(extra || {}) };
  vm.createContext(ctx);
  vm.runInContext(['studioTimezone', 'todayLocal', 'studioClock'].map(pick).join('\n'), ctx);
  return ctx.BPStore;
}
t('store: an unknown studio zone falls back to Asia/Kolkata, never the browser zone', () => {
  const S = mkStore(null);
  assert.equal(S.studioTimezone(), IST);
  assert.equal(S.todayLocal(new Date('2026-10-27T18:30:00Z')), '2026-10-28');
  assert.match(store, /return tz \|\| "Asia\/Kolkata";   \/\/ r37/);
});
t('store: report ranges ("Today", "This month") and timestamps use the studio day', () => {
  const a = store.indexOf('  function rangeFor(key, today) {'), b = store.indexOf('  /* ---------------- audit log (Phase 47)');
  assert.ok(a > 0 && b > a);
  const S = mkStore(IST);
  const ctx = { BPStore: S, Date, isNaN, String, Number };
  vm.createContext(ctx); vm.runInContext(store.slice(a, b).replace(/^\s*const /gm, 'var ') + '\nthis.rangeFor = rangeFor; this.inRange = inRange;', ctx);
  // 2026-09-30T20:00Z = 1 Oct 01:30 IST: an October payment, though the US browser says 30 Sep
  assert.equal(ctx.inRange('2026-09-30T20:00:00Z', { from: '2026-10-01', to: '2026-10-31' }), true);
  assert.equal(ctx.inRange('2026-09-30T20:00:00Z', { from: '2026-09-01', to: '2026-09-30' }), false);
  const today = S.todayLocal(); const rr = ctx.rangeFor('today');
  assert.equal(rr.from, today); assert.equal(rr.to, today);
  assert.equal(ctx.rangeFor('this_month').from, today.slice(0, 7) + '-01');
});
t('store: vendor bill overdue + default bill date + bell Today/Yesterday use the studio day', () => {
  assert.match(store, /const t = today \|\| BPStore\.todayLocal\(\);   \/\/ r37/);
  assert.match(store, /bill_date: day\(b\.bill_date\) \|\| BPStore\.todayLocal\(\),/);
  assert.match(store, /today0 = H\.dayStart\(td, tz\)\.getTime\(\); yest0 = H\.dayStart\(H\.addDays\(td, -1\), tz\)\.getTime\(\);/);
  assert.match(store, /const localISODate = \(d\) => \{ if \(!d\) \{ try \{ const t = BPStore\.todayLocal\(\);/);
});
t('store: every page loads the new store-api.js (v296) and country-profile.js (v6)', () => {
  for (const f of ['calendar.html', 'quotes.html', 'reports.html', 'inbox.html', 'flow.html', 'dashboard.html']) {
    const h = r('public/' + f);
    assert.match(h, /store-api\.js\?v=301/, f); assert.match(h, /country-profile\.js\?v=7/, f);
    assert.ok(h.indexOf('country-profile.js') < h.indexOf('store-api.js'), f + ': helper before the store');
  }
});

/* ------------------------------------------------------------------ pages */
t('event reminders: "Today / Tomorrow / in N days" counts from the studio day', () => {
  const src = r('public/event-reminders.js');
  const a = src.indexOf('  function daysUntil('), b = src.indexOf('  function chipText(');
  const S = mkStore(IST);
  // pin "now" to 28 Oct 01:30 IST = 27 Oct in the US
  const fixed = new Date('2026-10-27T20:00:00Z');
  const clock = () => S.studioClock(fixed);
  const ctx = { global: { BPStore: { studioClock: clock } }, Date, Math, String };
  vm.createContext(ctx); vm.runInContext(src.slice(a, b) + '\nthis.daysUntil = daysUntil;', ctx);
  assert.equal(ctx.daysUntil('2026-10-28'), 0, 'today in the studio (the US browser would say tomorrow)');
  assert.equal(ctx.daysUntil('2026-10-29'), 1);
});
t('quote filters: Today / This week follow the studio calendar', () => {
  const src = r('public/quote-smart-filter.js');
  const S = mkStore(IST); const fixed = new Date('2026-10-27T20:00:00Z');
  const ctx = { window: { BPStore: { studioClock: () => S.studioClock(fixed) } }, Date, isNaN, String, Object, Array, Math, JSON, Number };
  ctx.globalThis = ctx; vm.createContext(ctx); vm.runInContext(src, ctx);
  const QS = ctx.window.HelmQuoteSmart || ctx.HelmQuoteSmart; assert.ok(QS && QS.range, 'HelmQuoteSmart.range');
  assert.equal(QS.range('today').from, '2026-10-28');
  assert.equal(QS.range('tomorrow').from, '2026-10-29');
  assert.deepEqual([QS.range('week').from, QS.range('week').to], ['2026-10-26', '2026-11-01'], 'Mon-Sun week of 28 Oct (Wed)');
});
t('inbox snooze: the picker reads the studio wall clock (16:00 = 16:00 IST)', () => {
  const src = r('public/inbox.js');
  const a = src.indexOf('  function studioTz() {'), b = src.indexOf('  function customSnooze(ids) {');
  assert.ok(a > 0 && b > a);
  const ctx = { window: { HelmCountry: H }, BPStore: { studioTimezone: () => IST }, Date, String };
  vm.createContext(ctx); vm.runInContext(src.slice(a, b) + '\nthis.fromStudioWall = fromStudioWall; this.studioWall = studioWall;', ctx);
  assert.equal(ctx.fromStudioWall('2026-10-28T16:00').toISOString(), '2026-10-28T10:30:00.000Z');
  const w = ctx.studioWall(Date.parse('2026-10-27T20:00:00Z')); assert.equal(w.getDate(), 28); assert.equal(w.getHours(), 1);
  assert.match(src, /t = v \? fromStudioWall\(v\) : null;/);
});
t('pages: "today" for overdue / past checks is the studio day (quotes, reports, flow, vendor bills, calendar, stock)', () => {
  assert.match(r('public/quotes.html'), /const todayISO=\(function\(\)\{ try\{ const t=BPStore\.todayLocal\(\);/);
  assert.match(r('public/reports.html'), /const today=\(\)=>\(function\(\)\{ try\{ const t=BPStore\.todayLocal\(\);/);
  assert.match(r('public/flow.html'), /function todayIso\(\)\{ return \(function\(\)\{ try\{ const t=BPStore\.todayLocal\(\);/);
  assert.match(r('public/vendor-bills-ui.js'), /function today\(\) \{ try \{ var B = typeof window !== "undefined" \? window\.BPStore : null, t = B && B\.todayLocal/);
  assert.match(r('public/events-calendar.js'), /var todayFn = opts\.today \|\| function \(\) \{ try \{ var B = /);
  assert.match(r('public/checkout-shortage.js'), /today = o\.today \|\| studioToday\(\);/);
  assert.match(r('public/booklet.js'), /today = H\.todayIn\(FMT\.currency === "AED" \? "Asia\/Dubai" : "Asia\/Kolkata"\)/);
});
/* ------------------------------------------------------------------ follow-ups: timestamps shown in the studio zone */
const AT = '2026-10-27T20:00:00Z';   // 28 Oct 01:30 IST; still 27 Oct (afternoon) in New York / Los Angeles
function lineFn(file, start, name) {
  const src = r(file); const i = src.indexOf(start); assert.ok(i >= 0, file + ': ' + start);
  const j = src.indexOf('\n', i); const code = src.slice(i, j);
  const ctx = { window: { BPStore: { studioTimezone: () => IST } }, Date, isNaN, dateLocale: () => 'en-GB' }; vm.createContext(ctx);
  vm.runInContext(code.replace(/^\s*const /, 'var ') + '\nthis.f = ' + name + ';', ctx); return ctx.f;
}
t('timestamps: closure checklist, package review, share checklist, issues show the STUDIO day + time', () => {
  assert.match(lineFn('public/closure-checklist.js', '  function when(at)', 'when')(AT), /28\/10\/2026/);
  assert.match(lineFn('public/pkg-review.js', '  function when(t)', 'when')(AT), /28 Oct/);
  assert.match(lineFn('public/share-checklist.js', '  function when(t)', 'when')(AT), /28 Oct 2026/);
  assert.match(lineFn('public/issues.html', '  const when=(t)=>', 'when')(AT), /28 Oct/);
  assert.match(lineFn('public/quotes.html', '  const shelfFmt=(iso)=>', 'shelfFmt')(AT), /28 Oct 2026/);
});
t('timestamps: the other displays pass the studio zone (no viewer zone)', () => {
  const Z = /timeZone:\s*\(function \(\) \{ try \{ var B = \(typeof window !== "undefined" && window\.BPStore\) \|\| null, z = B && B\.studioTimezone \? B\.studioTimezone\(\) : ""; if \(z\) return z; \} catch \(e\) \{\} return "Asia\/Kolkata"; \}\)\(\)/;
  for (const f of ['capacity-shortage.js', 'closure.html', 'flow-resume.js', 'privacy-pin-settings.js', 'client.js', 'auth-ui.js']) assert.match(r('public/' + f), Z, f);
});
t('timestamps: link views fallback reads the studio wall clock', () => {
  const src = r('public/link-views.js'); const a = src.indexOf('  function fmtDate(v) {'), b = src.indexOf('\n  }\n', a);
  const ctx = { global: { BPStore: { studioTimezone: () => IST }, HelmCountry: H }, Date, isNaN, String }; vm.createContext(ctx);
  vm.runInContext(src.slice(a, b + 4) + '\nthis.f = fmtDate;', ctx);
  assert.equal(ctx.f(AT), '28/10/2026, 01:30');
});
t('day maths: business month buckets, HQ (IST), vendor dates, public enquiry minimum use the studio / India day', () => {
  assert.match(r('public/shell-b-money.js'), /var now = \(function \(\) \{ try \{ var c = S\(\) && S\(\)\.studioClock \? S\(\)\.studioClock\(\) : null;/);
  const hq = r('public/hq.js'); assert.doesNotMatch(hq, /iso\(new Date\(\)\)/); assert.match(hq, /var tIst = istDay\(Date\.now\(\)\)/);
  const m = /function istDay\(ms\) \{[^\n]*\}/.exec(hq); const ctx = { Intl, Date }; vm.createContext(ctx); vm.runInContext(m[0] + '\nthis.f = istDay;', ctx);
  assert.equal(ctx.f(Date.parse('2026-10-27T18:30:00Z')), '2026-10-28'); assert.equal(ctx.f(Date.parse('2026-10-27T18:29:00Z')), '2026-10-27');
  assert.match(r('public/hq-invoice.js'), /timeZone: "Asia\/Kolkata"[^\n]*r37: HQ = India time/);
  assert.match(r('public/vendor-request.js'), /timeZone: "Asia\/Kolkata"/);
  assert.match(r('public/vendor-requests-ui.js'), /window\.BPStore\.todayLocal\(\)\) \|\| new Date/);
  const eh = r('public/enquiry.html'); assert.ok(eh.indexOf('country-profile.js?v=7') > 0 && eh.indexOf('country-profile.js') < eh.indexOf('enquiry.js'), 'enquiry loads the helper first');
  assert.match(r('public/enquiry.js'), /H\.todayIn\(H\.FALLBACK_TZ \|\| "Asia\/Kolkata"\)/);
});
t('no time-zone label on staff screens (owner: just show the studio zone, no "IST")', () => {
  for (const f of ['public/country-profile.js', 'public/store-api.js', 'public/inbox.js']) assert.doesNotMatch(r(f), /zoneLabel|tzLabel|timeZoneName/, f);
});

console.log(failed ? `r37 (TZ=${process.env.TZ}): ${failed} FAILED / ${n + failed}` : `r37 (TZ=${process.env.TZ}): ALL PASS (${n})`);
if (failed) process.exit(1);
