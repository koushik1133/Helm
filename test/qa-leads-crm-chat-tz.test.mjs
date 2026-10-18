// QA (release 1018-b, local staging run): B16 nurture add queue + greeting confirm, B17 CRM stage after convert,
// B18 studio timezone everywhere (device on America/Chicago, studio Asia/Kolkata), B30 leads / tour / chat / calendar polish.
process.env.TZ = 'America/Chicago';   // the QA browser's zone: every "today" / time below must still be the studio's (IST)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const r = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const store = r('public/store-api.js');
let n = 0, failed = 0;
async function t(name, fn) { try { await fn(); n++; console.log('  ok ' + name); } catch (e) { failed++; console.log('  FAIL ' + name + '\n' + (e && e.stack || e)); } }

// BPStore.todayLocal + studioClock, with the studio zone fixed to Asia/Kolkata
function clockStore(tz) {
  const pick = (name) => { const s = store.indexOf('BPStore.' + name + ' = function'); assert.ok(s > 0, name); const e = store.indexOf('\n  };\n', s); return store.slice(s, e + 5); };
  const ctx = { BPStore: { studioTimezone: () => tz }, Intl, Date, isNaN };
  vm.createContext(ctx); vm.runInContext(pick('todayLocal') + '\n' + pick('studioClock'), ctx);
  return ctx.BPStore;
}

/* ------------------------------------------------------------------ B16 nurture */
const NUR = r('public/nurture.html');
function nurtureHarness(addImpl) {
  const els = {}; const mk = (id, v) => (els[id] = { id, value: v || '', checked: false, attrs: {}, focus() { this.focused = true; },
    setAttribute(k, v2) { this.attrs[k] = v2; }, removeAttribute(k) { delete this.attrs[k]; } });
  ['n_name', 'n_email', 'n_phone', 'n_occ', 'n_occd'].forEach((k) => mk(k)); mk('n_type', 'anniversary'); mk('n_auto'); mk('n_add');
  const toasts = [], added = []; let renders = 0;
  const ctx = {
    $: (s) => els[s.replace(/^#/, '')], toasts, added,
    BPUI: { toast: (m, o) => toasts.push({ m, type: o && o.type }), friendlyError: (e) => String(e && e.message || e) },
    BPStore: { validate: { email: () => ({ ok: true }) }, staff: { phoneE164: (v) => ({ ok: true, value: v || null }) },
      nurture: { add: (row) => addImpl(row, added) } },
    render: async () => { renders++; }, renderAuto: async () => {},
  };
  const a = NUR.indexOf('  const NUR_FIELDS='), b = NUR.indexOf('  /* ---------------- occasions & automation');
  assert.ok(a > 0 && b > a, 'nurture add block');
  vm.createContext(ctx); vm.runInContext(NUR.slice(a, b).replace(/^\s*(const|let) /gm, 'var ') + '\nthis.addOne=addOne;', ctx);
  return { ctx, els, toasts, added, renders: () => renders };
}
const slowAdd = (row, added) => new Promise((res) => setTimeout(() => { added.push(row.name); res({ id: row.name }); }, 30));

await t('B16: a fast second Add is queued, not dropped; the form resets at once; each save shows a toast', async () => {
  const h = nurtureHarness(slowAdd);
  h.els.n_name.value = 'QA Nurture 1'; h.els.n_email.value = 'a@x.in'; h.els.n_auto.checked = true;
  const p1 = h.ctx.addOne();
  assert.equal(h.els.n_name.value, '', 'form resets on click'); assert.equal(h.els.n_email.value, ''); assert.equal(h.els.n_auto.checked, false);
  h.els.n_name.value = 'QA Nurture 2'; const p2 = h.ctx.addOne();          // typed + clicked while the first save is in flight
  h.els.n_name.value = 'QA Nurture 3'; h.ctx.addOne();
  h.els.n_name.value = 'QA Nurture 4'; const p4 = h.ctx.addOne();
  await p1; await p2; await p4;
  assert.deepEqual(h.added, ['QA Nurture 1', 'QA Nurture 2', 'QA Nurture 3', 'QA Nurture 4'], 'every add saved, in order');
  assert.equal(h.toasts.filter((x) => x.type === 'ok').length, 4); assert.match(h.toasts[0].m, /Added “QA Nurture 1” to the nurture list/);
  assert.equal(h.renders(), 1, 'one list refresh after the queue drains');
  assert.equal(h.els.n_add.attrs['aria-busy'], undefined, 'busy flag cleared');
});
await t('B16: a refused add is reported by name and its values come back into an empty form', async () => {
  const h = nurtureHarness(() => Promise.reject(new Error('Trial limit reached')));
  h.els.n_name.value = 'QA Nurture X'; h.els.n_phone.value = '+919876543210';
  await h.ctx.addOne();
  assert.equal(h.added.length, 0);
  assert.match(h.toasts[0].m, /“QA Nurture X” was not added: Trial limit reached/); assert.equal(h.toasts[0].type, 'err');
  assert.equal(h.els.n_name.value, 'QA Nurture X'); assert.equal(h.els.n_phone.value, '+919876543210');
});
await t('B16: an empty click while saves are pending does not nag; an empty click otherwise asks for a name', async () => {
  const h = nurtureHarness(slowAdd);
  h.els.n_name.value = 'A'; const p = h.ctx.addOne(); h.ctx.addOne(); await p;
  assert.equal(h.toasts.filter((x) => /Enter a name/.test(x.m)).length, 0);
  h.ctx.addOne(); assert.equal(h.toasts.filter((x) => /Enter a name/.test(x.m)).length, 1);
});
await t('B16: Send greeting asks first, says test mode in the trial and never sends there', () => {
  const g = NUR.slice(NUR.indexOf('// B16: a greeting goes to a real client'), NUR.indexOf('async function toggleAuto'));
  assert.ok(g.indexOf('BPUI.confirm(') > 0 && g.indexOf('BPUI.confirm(') < g.indexOf('BPStore.nurture.greet('), 'confirm before the send');
  assert.match(g, /if\(await inTrial\(\)\)\{ autoMsg\("err","Free trial test mode: greetings are sent once you choose a plan\. Nothing was sent\."\); return; \}/);
  assert.match(g, /if\(!ok\) return;/);
  assert.match(NUR, /\$\{trial\?'<span class="occ paused" title="Free trial test mode[^']*">Test mode · not sent<\/span>'/);
  assert.doesNotMatch(NUR, /return BPUI\.guard\(btn,async\(\)=>\{   \/\/ no duplicate rows on double-click/, 'the dropping guard is gone');
});

/* ------------------------------------------------------------------ B17 CRM stage */
await t('B17: "latest per lead" breaks a same-moment tie (convert writes discovery + quoted) on the live stage', () => {
  const s = store.indexOf('    _newestArchive(rows, live) {'), e = store.indexOf('\n    },', s);
  assert.ok(s > 0, '_newestArchive');
  const fn = vm.runInNewContext('({' + store.slice(s, e) + '\n    }})')._newestArchive;
  const at = '2026-10-18T09:00:00.123+00:00';
  // newest-first order as the server returns it (id desc = random between the two same-transaction rows)
  const rows = [{ id: 'z', lead_id: 'L1', archived_at: at, status: 'discovery' }, { id: 'a', lead_id: 'L1', archived_at: at, status: 'quoted' },
    { id: 'old', lead_id: 'L1', archived_at: '2026-10-17T09:00:00+00:00', status: 'new' },
    { id: 'm', lead_id: 'L2', archived_at: at, status: 'won' }];
  assert.deepEqual(JSON.parse(JSON.stringify(fn(rows, { L1: 'quoted', L2: 'won' }))), { L1: 'a', L2: 'm' });
  assert.equal(fn(rows, {}).L1, 'z', 'unknown live stage: the first (old) rule');
  assert.equal(fn([{ id: 'n1', lead_id: 'L1', archived_at: at, status: 'quoted' }, { id: 'n0', lead_id: 'L1', archived_at: '2026-10-18T08:00:00+00:00', status: 'discovery' }], { L1: 'discovery' }).L1, 'n1',
    'an older row never wins over a newer one');
});
await t('B17: the CRM latest row shows the lead\'s live stage; Full history keeps each snapshot', () => {
  const crm = r('public/crm.html');
  assert.match(crm, /function rowStage\(r\)\{ return \(!fAll && r\.live_status\) \? r\.live_status : r\.status; \}/);
  assert.match(crm, /<td class="muted">\$\{esc\(stgLbl\(rowStage\(r\)\)\)\}<\/td>/);
  assert.match(store, /supa\.from\("leads"\)\.select\("id,status"\)\.in\("id", lids0\)/);
  assert.match(store, /r\.rows\.forEach\(\(x\) => \{ if \(x\.lead_id && live\[x\.lead_id\] != null\) x\.live_status = live\[x\.lead_id\]; \}\);/);
  assert.match(store, /select\("id,lead_id,archived_at,status"\)\.in\("lead_id", ids\)/);
  assert.match(crm, /\$\{esc\(stgLbl\(s\)\)\}<\/option>/, 'Stage filter options are title-cased');
  assert.match(crm, /<td class="wrapc">\$\{esc\(r\.name\|\|"—"\)\}<\/td>/);
  assert.match(r('public/crm-polish.css'), /#rows td\.wrapc\{white-space:normal;/);
  assert.match(crm, /crm-polish\.css\?v=3/);
});

/* ------------------------------------------------------------------ B18 studio timezone */
await t('B18: "today" is the studio\'s day, not the Chicago device\'s', () => {
  const B = clockStore('Asia/Kolkata');
  const inst = new Date('2026-10-18T20:00:00Z');          // Chicago 18 Oct 15:00, Kolkata 19 Oct 01:30
  assert.equal(inst.getDate(), 18, 'the device really is behind');
  assert.equal(B.todayLocal(inst), '2026-10-19');
  const c = B.studioClock(inst); assert.equal(c.date, '2026-10-19'); assert.equal(c.h, 1); assert.equal(c.mi, 30);
  assert.equal(clockStore(undefined).todayLocal(inst), '2026-10-18', 'no studio zone known: device day (old behaviour)');
});
await t('B18: crew shift blocks for a 28 Oct 19:00 IST event draw on 28 Oct 19:00-01:00 (not 27 Oct / 04:30 split)', () => {
  const B = clockStore('Asia/Kolkata');
  const ctx = { window: { BPStore: B }, Intl, Date, isNaN, isFinite, Math, String, Number, Array, Object };
  vm.createContext(ctx); vm.runInContext(r('public/crew-schedule.js'), ctx);
  const C = ctx.window.HelmCrewSchedule;
  const row = { crew_id: 'c1', crew_name: 'Meena', quote_id: 'q1', event_date: '2026-10-28', task_title: 'Service',
    planned_start: '2026-10-28T13:30:00Z', planned_end: '2026-10-28T19:30:00Z' };
  assert.equal(C._dayOf(row), '2026-10-28');
  assert.equal(C._timeOf(row), '19:00–01:00');
  const g = C._group([row], false, false); assert.equal(g.length, 1); assert.equal(g[0].day, '2026-10-28'); assert.equal(g[0].time, '19:00–01:00');
  assert.equal(new Date(g[0].start).getHours(), 19, 'grid position uses the studio hour');
});
await t('B18: date pickers, calendar, dashboard, chat, activity log use the studio day / zone', () => {
  assert.match(store, /if \(!el\.getAttribute\("min"\)\) el\.setAttribute\("min", win === "future" \? todayIso\(\) :/);
  assert.match(store, /function addYears\(n\) \{ var t = todayIso\(\)\.split\("-"\)/);
  const cal = r('public/calendar.html'); assert.match(cal, /const todayISO=BPStore\.todayLocal\(\);/);
  const sbd = r('public/shell-b-dash.js');
  assert.match(sbd, /var real = new Date\(\), now = wallNow\(\), isToday = todayOf\(real\) === ev\.date, st;/);
  assert.match(sbd, /var hr = wallNow\(\)\.getHours\(\), tod/);
  assert.match(sbd, /var today = todayOf\(now\), todayD = dOf\(today\);/);
  assert.match(r('public/dashboard.html'), /function eg\(\) \{ let t = ""; try \{ t = BPStore\.todayLocal\(\); \}/);
  const chat = r('public/chat.html'); assert.match(chat, /const SF=\(ts,f\)=>\{ try\{ const o=BPStore\.fmtStudioDate\(new Date\(ts\),\{fmt:f\}\);/);
  assert.doesNotMatch(chat, /toLocaleTimeString\(\[\]/);
  assert.match(r('public/audit.html'), /const fmt=\(iso\)=>\{ try\{ const o=BPStore\.fmtStudioDate\(iso,/);
});
await t('B18: activity-log diff timestamps read in IST when the studio formatter is not loaded (node)', () => {
  const A = (0, eval)('(function(){ const module={exports:{}}; ' + r('public/audit-format.js').replace('(typeof window!==\'undefined\'?window:globalThis)', '({})') + '; return module.exports; })()');
  const out = A.fmtTs('2026-10-18T20:00:00Z');
  assert.match(out, /19 Oct 2026/); assert.match(out, /01:30/i);
});

/* ------------------------------------------------------------------ B30 polish */
await t('B30 leads: no future birthday / anniversary in the picker, readable phone + dates in the detail, edit returns to the detail', () => {
  const L = r('public/leads.html');
  assert.match(L, /<input id="f_name" required maxlength="80"/);
  assert.match(L, /\{ const td=BPStore\.todayLocal\(\); \$\("#f_bday"\)\.max=td; \$\("#f_anniv"\)\.max=td; \}/);
  assert.match(L, /if\(bd && bd>td\)\{ fail\("Birthday can't be in the future\."\); return; \}/);
  assert.match(L, /\["Birthday", l\.birthday\?BPStore\.fmtDateIN/);
  assert.match(L, /if\(id && back===id && leadById\(id\)\) openDetail\(id\);/);
  const s = L.indexOf('  const fmtPhone=(p)=>'), e = L.indexOf('return s; };', s) + 11;
  const fmtPhone = vm.runInNewContext(L.slice(s, e).replace('const fmtPhone=', '(') + ')');
  assert.equal(fmtPhone('+919876543210'), '+91 98765 43210'); assert.equal(fmtPhone('9876543210'), '98765 43210');
  assert.equal(fmtPhone('+971501234567'), '+971 50 123 4567'); assert.equal(fmtPhone('+13125550100'), '+1 312 555 0100');
  assert.equal(fmtPhone('ext. 12'), 'ext. 12');
});
await t('B30 tour: welcome reads days left + the "Sample" tag, New-menu step lists the real options, sidebar tucks away', () => {
  const D = r('public/dashboard.html');
  assert.doesNotMatch(D.slice(D.indexOf('const TOUR_WELCOME={'), D.indexOf('const TOUR=[')), /8-day|“Demo ·”/);
  assert.match(D, /const n=T&&T\.is_trial_org===true&&T\.days_left!=null\?Number\(T\.days_left\):NaN;/);
  assert.match(D, /title:"Create something new", get desc\(\)\{ return TOUR_NEW\(\); \}/);
  const s = D.indexOf('  const TOUR_NEW=()=>'), e = D.indexOf('."; };', s) + 6;
  const mk = (list) => vm.runInNewContext(D.slice(s, e).replace('const TOUR_NEW=', 'var TOUR_NEW=') + ';TOUR_NEW()', { window: { __helmNewMenu: list } });
  assert.equal(mk(['New lead', 'Inventory item', 'Vendor']), '“New quote” starts pricing an event. The little arrow next to it opens more: a new lead, inventory item or vendor.');
  assert.doesNotMatch(mk(['New lead']), /client/);
  assert.match(r('public/shell-b-dash.js'), /window\.__helmNewMenu = items\.slice\(1\)\.map\(function \(i\) \{ return i\.t; \}\);/);
  const T = r('public/tour.js');
  assert.match(T, /tuckRail\(!\(tgt && tgt\.closest && tgt\.closest\("#hbRail"\)\)\);/);
  assert.match(T, /html\.htour-tuck:not\(\.hb-pinned\) \.hb-rail\{width:var\(--hb-w\)!important/);
  assert.match(T, /function end\(\) \{\n    const had = !!root;\n    tuckRail\(false\);/);
});
await t('B30 calendar: one status word with the dashboard (Closed / Confirmed / Tentative via quoteStatus)', () => {
  const cal = r('public/calendar.html');
  assert.match(cal, /const stLabel=\(e\)=>\{ const q=qStat\(e\); return q&&q\.key==="closed"\?"Closed":isConfirmed\(e\)\?"Confirmed":"Tentative"; \};/);
  assert.match(cal, /<span class="stb \$\{conf\?'confirmed':'tentative'\}">\$\{esc\(stLabel\(e\)\)\}<\/span>/);
  assert.match(cal, /return a\?\(isConfirmed\(a\.event\)\?"confirmed":"tentative"\):"";/);
});
await t('B30 chat: sample names, group validation, alone-in-studio hint, leave group, optimistic delete, deleted preview', () => {
  const C = r('public/chat.html');
  const s = C.indexOf('  const DEMO_PFX='), e = C.indexOf('  /* names: display name', s);
  const f = vm.runInNewContext(C.slice(s, e).replace(/const /g, 'var ') + ';({stripDemo,initials})');
  assert.equal(f.stripDemo('Demo · Kapoor'), 'Kapoor'); assert.equal(f.initials('Demo · Kapoor Family'), 'KF'); assert.equal(f.initials('Demo · Ravi'), 'R');
  assert.equal(f.stripDemo('Demo · '), 'Demo · ', 'never blanks a name'); assert.equal(f.initials('Priya Sharma'), 'PS');
  assert.match(C, /function pname\(p\)\{ return stripDemo\(/);
  assert.match(C, /if\(m\.deleted\) return who\+'<i>🚫 Message deleted<\/i>';/);
  assert.match(C, /if\(msg\)\{ Object\.assign\(msg,\{deleted:true,body:null,media_path:null,meta:null\}\);/);
  assert.match(C, /catch\(e\)\{ if\(msg&&was\)\{ Object\.assign\(msg,was\);/);
  assert.match(C, /\(others\(\)\.length\?'<div data-st="padding:16px;color:var\(--ink-3\)">Everyone is already in this group\.<\/div>':'<div class="invite"><b>No teammates to add yet\.<\/b>/);
  assert.match(C, /if\(c\.kind==="group"&&BPStore\.chat\.leaveGroup\) items\.push\(\{k:"leave",label:"🚪  Leave group",on:leaveGroup\}\);/);
  const lg = C.slice(C.indexOf('async function leaveGroup(){'), C.indexOf('async function refreshEventDetails(){'));
  assert.ok(lg.indexOf('BPUI.confirm(') < lg.indexOf('BPStore.chat.leaveGroup('), 'confirm before leaving');
  const ls = store.slice(store.indexOf('    async leaveGroup(convId) {'), store.indexOf('    prefs: chatPrefs,'));
  assert.match(ls, /\.from\("chat_members"\)\.delete\(\)\.eq\("conversation_id", convId\)\.eq\("user_id", uidMe\)/, 'only MY membership row');
  assert.match(ls, /if \(!cv \|\| cv\.kind !== "group"\) throw new Error\("Only a group can be left\."\);/);
  assert.doesNotMatch(ls, /chat_messages|chat_conversations"\)\.delete/, 'never deletes messages or the conversation');
});
await t('B30 invitation: the "Demo ·" sample prefix never reaches the guest-facing prefill', () => {
  const I = r('public/invite-studio.html');
  const s = I.indexOf('    const noDemo=(v)=>'), e = I.indexOf('\n', s);
  const noDemo = vm.runInNewContext(I.slice(s, e).replace('const noDemo=', '(').replace(/;\s*$/, '') + ')');
  assert.equal(noDemo('Demo · Kapoor Family Sangeet'), 'Kapoor Family Sangeet'); assert.equal(noDemo('Ayla & Sam'), 'Ayla & Sam');
  assert.match(I, /const set=\(id,v\)=>\{ if\(v!=null && String\(v\)\.trim\(\) && !\$\("#"\+id\)\.value\) \$\("#"\+id\)\.value=noDemo\(v\); \};/);
});

console.log(`\nqa-leads-crm-chat-tz: ${n} passed${failed ? ', ' + failed + ' FAILED' : ''}`);
if (failed) process.exit(1);
