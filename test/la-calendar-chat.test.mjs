// la-calendar-chat (cal-1018 / chatfix-1018): live-audit fixes for the calendar team schedule and team chat.
// Audit items 15, 16, 17, 18, 37, 38.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const r = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0; const t = (m, f) => { f(); n++; console.log('ok - ' + m); };

const CS = r('public/crew-schedule.js'), CSS = r('public/crew-schedule.css'), CAL = r('public/calendar.html'), CHAT = r('public/chat.html');

/* ---------- minimal DOM so crew-schedule.js can render into a fake root ---------- */
function mountGrid({ narrow = false, events = [], extra = [], people = [], rows = [] } = {}) {
  const store = { html: '' };
  const node = () => ({ hidden: false, textContent: '', value: '', style: { cssText: '' }, dataset: {},
    setAttribute() {}, getAttribute() { return null }, removeAttribute() {}, addEventListener() {}, querySelectorAll: () => [], querySelector: () => null, insertAdjacentHTML() {}, focus() {} });
  const body = node(); Object.defineProperty(body, 'innerHTML', { get: () => store.html, set: (v) => { store.html = v; } });
  const range = node(), sel = node();
  const root = node(); root.innerHTML = '';
  root.querySelector = (s) => (s === '#csBody' ? body : s === '#csRange' ? range : s === '#csStaff' ? sel : null);
  root.querySelectorAll = () => [];
  let resolve; const p = new Promise((res) => { resolve = res; });
  const win = { matchMedia: () => ({ matches: narrow }) };
  const ctx = { window: win, document: { addEventListener() {} }, console, BPStore: { ops: { crew: { schedule: () => Promise.resolve(rows) } } } };
  vm.createContext(ctx); vm.runInContext(CS, ctx);
  const ui = ctx.window.HelmCrewSchedule.mount(root, { team: true, view: 'week', people, events: () => events, extra: () => extra, statusFor: (q) => (q === 'q1' ? 'confirmed' : 'draft') });
  return ui.ready.then(() => ({ html: store.html, range: range.textContent, C: ctx.window.HelmCrewSchedule }));
}
const pad = (x) => String(x).padStart(2, '0');
const iso = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const today = new Date(); const td = iso(today);

t('17: team grid takes every dated event from the page (opts.events), not only crew rows', () => {
  assert.match(CS, /var events = opts\.events \|\| function \(\) \{ return \[\]; \};/);
  assert.match(CS, /if \(allCrew\(\)\) evBlocks\(out\)\.forEach/);
  assert.match(CS, /<tr class="cs-evrow"><th scope="row" class="cs-who">Events<\/th>/);
  assert.match(CS, /\["Crew", b\.crewOther \? "None on this day \(crew is on another day\)" : "No crew on this day yet"\]/);
  assert.match(CS, /crewOther: !!crewed\[e\.quote_id\]/);
  // calendar passes dated, not-cancelled agenda events + shows the Lead legend only to roles that see leads
  assert.match(CAL, /events:\(\)=>\(\(data&&data\.agenda\)\|\|\[\]\)\.filter\(a=>a&&a\.event&&validDate\(a\.event\.eventDate\)&&String\(a\.event\.status\|\|""\)\.toLowerCase\(\)!=="cancelled"\)/);
  assert.match(CAL, /leadLegend:canLeads/);
  assert.match(CS, /team && opts\.leadLegend !== false \?/);
});

t('18: the grid opts out of tables-mobile card conversion and is 3 days per person on phones', () => {
  assert.match(CS, /<table class="cs-grid cs-grid-' \+ ds\.length \+ '" data-tm="off">/);
  assert.match(r('public/tables-mobile.js'), /if \(table\.getAttribute\("data-tm"\) === "off"\) return;/);
  assert.match(CS, /st\.view === "week" \? \(narrow\(\) \? 3 : 7\)/);
  assert.match(CSS, /\.cs-grid\.cs-grid-3,\.cs-grid\.cs-grid-1\{min-width:0\}/);
});

await (async () => {
  const d1 = iso(new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1));
  const res = await mountGrid({ narrow: true, people: [{ id: 's1', name: 'Ravi' }],
    events: [{ quote_id: 'q1', day: td, title: 'Sharma wedding' }, { quote_id: 'q2', day: d1, title: 'Offsite' }, { quote_id: 'q9', day: 'junk', title: 'Bad' }],
    extra: [{ day: td, title: 'Lead A' }] });
  t('17/18 render: Events row lists events with no crew + leads; 3 day columns on phones; junk dates skipped', () => {
    const head = res.html.slice(res.html.indexOf('<thead>'), res.html.indexOf('</thead>'));
    assert.equal((head.match(/<th scope="col"/g) || []).length, 4);                         // Crew + 3 days
    const ev = res.html.slice(res.html.indexOf('cs-evrow'), res.html.indexOf('</tr>', res.html.indexOf('cs-evrow')));
    assert.match(ev, /Sharma wedding, all day, Confirmed/); assert.match(ev, /Offsite, all day, Tentative/); assert.match(ev, /Lead A, all day, Lead/);
    assert.doesNotMatch(res.html, /Bad/);
    assert.match(res.html, />Ravi</);
  });
  const res2 = await mountGrid({ narrow: false, events: [{ quote_id: 'q1', day: td, title: 'Sharma wedding' }],
    rows: [{ crew_id: 'c1', crew_name: 'Meena', quote_id: 'q1', event_title: 'Sharma wedding', event_date: td }] });
  t('17 render: an event with crew shows once in Events (no duplicate block) and under the person; desktop = 7 days', () => {
    const ev = res2.html.slice(res2.html.indexOf('cs-evrow'), res2.html.indexOf('</tr>', res2.html.indexOf('cs-evrow')));
    assert.equal((ev.match(/Sharma wedding, all day/g) || []).length, 1);
    assert.match(res2.html, />Meena</);
    const head = res2.html.slice(res2.html.indexOf('<thead>'), res2.html.indexOf('</thead>'));
    assert.equal((head.match(/<th scope="col"/g) || []).length, 8);
  });
  const res3 = await mountGrid({ events: [{ quote_id: 'q1', day: td, title: 'Solo event' }] });
  t('17 render: no crew at all still draws the events row plus the "No crew yet" hint', () => {
    assert.match(res3.html, /Solo event/); assert.match(res3.html, /No crew yet\. Add people on the Staff page/);
  });
  t('37: Month -> Day / Week lands on today when today is in the month on screen', () => {
    const C = res.C, now = new Date(2026, 9, 18, 15, 0);
    assert.equal(iso(C._switchAnchor('month', 'day', new Date(2026, 9, 1), now)), '2026-10-18');
    assert.equal(iso(C._switchAnchor('month', 'week', new Date(2026, 9, 1), now)), '2026-10-18');
    assert.equal(iso(C._switchAnchor('month', 'day', new Date(2026, 11, 1), now)), '2026-12-01');   // another month: keep its 1st
    assert.equal(iso(C._switchAnchor('week', 'day', new Date(2026, 9, 12), now)), '2026-10-12');    // only from Month
    assert.match(CS, /st\.anchor = switchAnchor\(st\.view, to, st\.anchor, nowW\(\)\);/);   // B18: the studio's "now"
  });
})();

t('37: "No date set" asks before saving and offers Undo that restores the old value + title', () => {
  assert.match(CAL, /ok=await BPUI\.confirm\("Set the date of "\+label\+" to "\+fmtDate\(v\)/);
  assert.match(CAL, /if\(!ok\)\{ inp\.value=""; delete inp\.dataset\.busy;/);
  assert.match(CAL, /action:\{label:"Undo",onClick:\(\)=>undoDate\(undoEv\)\}/);
  assert.match(CAL, /const patch=\{eventDate:ev\.eventDate\|\|null\}; if\(ev\.title\) patch\.title=ev\.title;/);
  // the old save-on-change path is gone
  assert.doesNotMatch(CAL, /BPStore\.quotes\.updateMeta\(inp\.dataset\.set,\{eventDate:inp\.value\}\)/);
});

t('37: mobile pills centred, normal-font date headings, short page title', () => {
  assert.match(CAL, /\.ev \.chips\{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-left:auto\}/);
  assert.match(CAL, /\.chip\{display:inline-flex;align-items:center;/);
  assert.match(CAL, /\.day \.hd \.dt\{font-weight:700;font-size:14px\}/);
  assert.match(CAL, /<title>Calendar — Helm Events<\/title>/); assert.match(CAL, /<small>Calendar<\/small>/);
});

t('15: chat composer can shrink so #micBtn stays on a 375px screen', () => {
  assert.match(CHAT, /\.inputwrap\{flex:1 1 auto;min-width:0;/);
  assert.match(CHAT, /\.cbar textarea\{flex:1 1 auto;min-width:0;width:100%;/);
  assert.match(CHAT, /@media\(max-width:420px\)\{.*#camBtn\{display:none\}\}/);
});

t('16: chat dialogs sit on the 1100 layer above the app header (800), same as the shared .lmodal rule', () => {
  assert.match(CHAT, /\.ov\{position:fixed;inset:0;[^}]*z-index:1100;/);
  assert.match(CHAT, /\.lightbox\{[^}]*z-index:1150;/); assert.match(CHAT, /\.imgedit\{[^}]*z-index:1150;/);
  assert.doesNotMatch(CHAT, /z-index:60;padding:20px/);
});

t('38: focus returns to the opener; dialogs are labelled', () => {
  assert.match(CHAT, /function showModal\(ov\)\{/);
  assert.match(CHAT, /modalOpener=\(a&&a!==document\.body&&a\.isConnected&&!a\.closest\("\.menu"\)\)\?a:menuAnchor;/);
  assert.match(CHAT, /m\.setAttribute\("role","dialog"\); m\.setAttribute\("aria-modal","true"\)/);
  assert.match(CHAT, /if\(o\) setTimeout\(\(\)=>\{ const ae=document\.activeElement; if\(\(!ae\|\|ae===document\.body\)&&o\.isConnected/);
  assert.equal((CHAT.match(/document\.body\.appendChild\(ov\)/g) || []).length, 1);   // only inside showModal
});

t('38: New group needs a name (max 80) and at least one teammate', () => {
  assert.match(CHAT, /maxlength="\$\{GROUP_NAME_MAX\}"/); assert.match(CHAT, /const GROUP_NAME_MAX=80;/);
  // B30: Create is never a dead (disabled) button - it is aria-disabled and pressing it says what is missing
  assert.match(CHAT, /<button class="btn primary" id="gCreate" aria-disabled="true">Create<\/button>/);
  assert.match(CHAT, /if\(!v\.ok\)\{ const er=\$\("#gErr",ov\); er\.textContent=v\.msg; er\.hidden=false;/);
  const src = CHAT.slice(CHAT.indexOf('function groupCheck('), CHAT.indexOf('function others('));
  const groupCheck = vm.runInNewContext('const GROUP_NAME_MAX=80;' + src + ';groupCheck');
  assert.equal(groupCheck('   ', ['a']).field, 'name');
  assert.equal(groupCheck('x'.repeat(81), ['a']).field, 'name');
  assert.equal(groupCheck('Setup crew', []).field, 'members');
  const ok = groupCheck('  Setup   crew ', ['a', 'b']); assert.equal(ok.ok, true); assert.equal(ok.name, 'Setup crew'); assert.equal(ok.count, 2);
});

t('38: empty New chat / New group point to inviting a teammate; ⋮ no longer repeats ＋', () => {
  assert.match(CHAT, /const INVITE_HREF="control\.html#users";/);
  assert.match(CHAT, /<b>No teammates in your studio yet\.<\/b><br>'\+inviteHint\(\)/);
  assert.match(CHAT, /<b>No teammates to add yet\.<\/b><br>'\+inviteHint\(\)/);
  assert.match(CHAT, /canInvite=!!\(await BPStore\.auth\.canEditArea\("users"\)\)/);
  const dots = CHAT.slice(CHAT.indexOf('$("#menuBtn").addEventListener'), CHAT.indexOf('async function markAllRead'));
  assert.doesNotMatch(dots, /newDmModal|newGroupModal/);
  assert.match(dots, /Mark all as read/); assert.match(dots, /if\(canInvite\) items\.push\(\{k:"invite"/);
  const plus = CHAT.slice(CHAT.indexOf('$("#plusBtn").addEventListener'), CHAT.indexOf('$("#menuBtn").addEventListener'));
  assert.match(plus, /newDmModal/); assert.match(plus, /newGroupModal/);
});

console.log(n + ' passed');
