#!/usr/bin/env node
/* tour-order.test.mjs — the first-run product tour walks the screen in reading order
 * and never jumps to (or highlights) something that is not there.
 *
 * Owner complaint: after onboarding (paid "Create studio" and the free-trial welcome) the
 * tour went sidebar -> search -> somewhere else -> back. It must go:
 *   1. the left sidebar top to bottom (pin, Dashboard, Quotes, Leads, Calendar, Chat,
 *      Manage, Admin / Control Center, theme, profile),
 *   2. the top bar left to right (search, hide amounts, chat, notifications, New quote),
 *   3. the dashboard top to bottom (Today, greeting + next event, Customize, KPI tiles),
 *   4. the getting-started checklist, then a wrap-up card.
 * Hidden / missing targets are skipped (and not counted in "Step n of N"); free-trial
 * studios never get steps about pages they do not have.
 * Pure Node: the real tour.js runs in a small stubbed DOM (node:vm). */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const r = (p) => readFileSync(join(ROOT, 'public', p), 'utf8');
const D = r('dashboard.html'), SRC = r('tour.js'), SHELL = r('shell-b.js'), DASH = r('shell-b-dash.js'), PRIV = r('shell-b-privacy.js');
let passed = 0;
const t = (n, f) => { f(); passed++; console.log('  ✓ ' + n); };

/* ---- the dashboard TOUR array, evaluated as real JS ---- */
const a = D.indexOf("const RAIL='"), b = D.indexOf('];', D.indexOf('const TOUR=[', a)) + 2;
assert.ok(a > 0 && b > a, 'dashboard.html defines RAIL + TOUR');
const TOUR = vm.runInNewContext(D.slice(a, b).replace(/^\s*const /gm, 'var ') + '\nTOUR');
const first = (st) => (Array.isArray(st.sel) ? st.sel[0] : st.sel) || '';
const key = (st) => { const s = first(st); const m = /data-nav="([\w-]+)"/.exec(s) || /data-tour="([\w-]+)"/.exec(s); return m ? (/data-nav/.test(s) ? 'rail:' : '') + m[1] : (st.sel ? s : '(card)'); };
const KEYS = Array.from(TOUR, key);   // Array.from: plain arrays of this realm (vm arrays fail deepStrictEqual)

t('dashboard tour follows the on-screen reading order exactly', () => {
  assert.deepEqual(KEYS, [
    '(card)',                                                     // welcome
    'pin', 'rail:dashboard', 'rail:quotes', 'rail:leads', 'rail:calendar', 'rail:chat', 'nav-manage', 'nav-admin', 'theme', 'account',   // sidebar
    'search', 'privacy', 'chat', 'bell', 'new',                   // top bar, left to right
    'today', 'hero', 'customize', 'kpis', '#myworkSection',                      // main content, top to bottom
    'setup',                                                      // getting-started checklist
    '(card)',                                                     // wrap-up
  ]);
  assert.match(TOUR[TOUR.length - 1].desc, /Tour this page/);
});

t('welcome step: trial wording for a free-trial studio, studio wording for a paid one', () => {
  const ev = (trial) => vm.runInNewContext(D.slice(a, b).replace(/^\s*const /gm, 'var ') + '\nTOUR[0].desc',
    { document: { documentElement: { classList: { contains: (c) => trial && c === 'helm-trial' } } } });
  const tr = ev(true), pd = ev(false);
  // B30: no hard-coded "8-day" / "Demo ·": the days left come from the server, the label is the "Sample" badge the screens show
  assert.match(tr, /Your free trial is loaded with sample data tagged “Sample”/);
  assert.doesNotMatch(tr, /8-day|Demo ·/);
  assert.match(pd, /^Welcome to Helm — here's a quick look around your studio\./);
  assert.doesNotMatch(pd, /trial|sample data|Demo/i);
  assert.equal(TOUR.length, 23, 'still 23 steps (r47: + My events & tasks)');
});

t('sidebar steps sit beside the rail (side:"right"), top-bar / content steps do not', () => {
  for (let k = 1; k <= 10; k++) assert.equal(TOUR[k].side, 'right', KEYS[k]);
  for (let k = 11; k < TOUR.length; k++) assert.notEqual(TOUR[k].side, 'right', KEYS[k]);
});

t('the order matches how the shell actually lays the screen out', () => {
  // rail Workspace items, in the order shell-b.js builds them
  const work = /\[\["dashboard", "Dashboard"[\s\S]*?\]\]\.forEach/.exec(SHELL)[0];
  const order = [...work.matchAll(/\["(\w+)", "/g)].map((m) => m[1]);
  assert.deepEqual(order, ['dashboard', 'quotes', 'leads', 'calendar', 'chat']);
  assert.ok(SHELL.indexOf('scroll.appendChild(work); scroll.appendChild(manage); scroll.appendChild(admin);') > 0, 'Workspace, Manage, Admin');
  assert.match(SHELL, /bottom\.appendChild\(themeSlot\); bottom\.appendChild\(acctSlot\);/, 'theme above the profile at the foot');
  assert.match(SHELL, /manage\.setAttribute\("data-tour", "nav-manage"\)/);
  assert.match(SHELL, /admin\.setAttribute\("data-tour", "nav-admin"\)/);
  // top bar: search, (eye inserted right after search), chat, bell, New quote
  assert.match(SHELL, /tools\.appendChild\(searchSlot\); tools\.appendChild\(chat\); tools\.appendChild\(bellSlot\); tools\.appendChild\(split\);/);
  assert.match(PRIV, /var after = tools\.querySelector\("\.hb-search"\);\s*if \(after && after\.nextSibling\) tools\.insertBefore\(btn, after\.nextSibling\)/);
  // dashboard: Today strip, hero (greeting, actions incl. Customize, next event), KPI strip
  const iToday = DASH.indexOf('todayBar.setAttribute("data-tour", "today")'), iHero = DASH.indexOf('hero.setAttribute("data-tour", "hero")');
  const iCz = DASH.indexOf('czBtn.setAttribute("data-tour", "customize")'), iKpi = DASH.indexOf('kpis.setAttribute("data-tour", "kpis")');
  assert.ok(iToday > 0 && iToday < iHero && iHero < iCz && iCz < iKpi, 'today < hero < customize < kpis');
});

t('the generic shell tour (pages without their own steps) also goes sidebar first, then the top bar', () => {
  const blk = SHELL.slice(SHELL.indexOf('var SHELL_TOUR = ['), SHELL.indexOf('];', SHELL.indexOf('var SHELL_TOUR = [')));
  const ks = [...blk.matchAll(/sel: "([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ks, ["[data-tour='pin']", '#hbRail .hb-group:not(.hb-fav)', '.hb-recent .htr-btn', "[data-tour='theme']", "[data-tour='account']",
    "[data-tour='search']", "[data-tour='bell']", "[data-tour='new']"]);
});

t('per-page steps follow each toolbar left to right, then the content below', () => {
  const T = loadTour().T;
  const sels = (pg) => Array.from(T._steps[pg], (s) => (Array.isArray(s.sel) ? s.sel[0] : s.sel));
  // R46: every page tour has 4-8 steps (page-tours.js), still in on-screen order
  assert.deepEqual(sels('quotes.html'), ['#tabs', '#search', '#typeFilter', '#newBtn', '#rows']);
  assert.deepEqual(sels('leads.html'), ['#search', '#archBtn', '#enqBtn', '#newBtn', '#board']);
  assert.deepEqual(sels('staff.html'), ['#search', '#deptFilter', '#importBtn', '#newBtn', '#grid']);
  assert.deepEqual(sels('inventory.html'), ['#eventPanel', '#search', '#seedBtn', '#newBtn', '#pane-loans', '#lossRows']);
  // r20: the builder's first-run tour walks the one-row header left to right (the r19 two-row header was reverted), then the panels
  assert.deepEqual(sels('builder.html'), ['header .brand', '#preset', '#refField', '#customBtn', '#unitSel', '.seg:has(#snapBtn)', '#viewSeg',
    '.wt-field', '#wtStart', '#measureBtn', '.hg-edit', '#projName', '#verSel', '#designChip', '#backToFlowBtn', '#saveBtn', '#loadBtn', '#clientImgBtn',
    '#moreMenu', '.hg-cap', '.bp-priv-slot .hbp-btn', '#toolbox', '#fabStack', '#rightPanel']);
  // and that is the DOM order of those elements on the page
  for (const [pg, ids] of [['quotes.html', ['tabs', 'search', 'typeFilter', 'newBtn', 'rows']], ['leads.html', ['search', 'archBtn', 'enqBtn', 'newBtn', 'board']],
    ['staff.html', ['search', 'deptFilter', 'importBtn', 'newBtn', 'grid']], ['inventory.html', ['eventPanel', 'search', 'seedBtn', 'newBtn', 'pane-loans', 'lossRows']], ['builder.html', ['preset', 'refField', 'customBtn', 'unitSel', 'snapBtn', 'viewSeg', 'measureBtn', 'undoBtn',
      'projName', 'verSel', 'designChip', 'backToFlowBtn', 'saveBtn', 'loadBtn', 'clientImgBtn', 'moreMenu', 'capInput', 'toolbox',
      'fabStack', 'rightPanel']]]) {
    const H = r(pg), pos = ids.map((id) => H.indexOf('id="' + id + '"'));
    assert.ok(pos.every((p, k) => p > 0 && (k === 0 || p > pos[k - 1])), pg + ' DOM order ' + pos);
  }
});

t('trial: steps about pages a free trial does not have are marked trial:false', () => {
  assert.equal(TOUR[KEYS.indexOf('setup')].trial, false, 'getting-started / studio set-up chip');
  const T = loadTour().T;
  assert.equal(T._steps['logistics.html'].find((s) => s.sel === '#tplBar').trial, false, 'templates');
  assert.equal(T._steps['runsheet.html'].find((s) => s.sel === '#printBtn').trial, false, 'print / export');
  // nothing else in the dashboard tour points at a trial-hidden page
  for (const st of TOUR) for (const s of [].concat(st.sel || [])) assert.doesNotMatch(s, /onboarding|import|export|render|notif|templates|brand/i, s);
});

/* ---- behaviour: the real engine in a stubbed DOM ---- */
function fake() {
  const kids = {}, cls = new Set();
  return {
    style: {}, textContent: '', offsetWidth: 320, offsetHeight: 170, innerHTML: '',
    classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c), toggle: (c, on) => (on === undefined ? (cls.has(c) ? cls.delete(c) : cls.add(c)) : on ? cls.add(c) : cls.delete(c)), contains: (c) => cls.has(c) },
    addEventListener() {}, removeEventListener() {}, appendChild() {}, remove() {}, focus() {}, contains: () => false,
    querySelector(sel) { return kids[sel] || (kids[sel] = fake()); }, querySelectorAll: () => [],
  };
}
const rect = (left, top, w, h) => ({ left, top, width: w, height: h, right: left + w, bottom: top + h });
function target(x, y, w = 160, h = 36, o = {}) {
  return Object.assign({ hidden: false, closest: () => null, parentElement: null, scrolled: 0,
    getBoundingClientRect: () => rect(x, y, w, h), scrollIntoView() { this.scrolled++; } }, o);
}
function loadTour({ els = {}, trial = false, vw = 1280, vh = 800 } = {}) {
  const noop = () => {};
  const html = { clientWidth: vw, clientHeight: vh, classList: { contains: (c) => trial && c === 'helm-trial' } };
  const document = {
    readyState: 'complete', hidden: false, head: { appendChild: noop }, body: { appendChild: noop }, documentElement: html, activeElement: null,
    createElement: fake, getElementById: () => null, addEventListener: noop, removeEventListener: noop,
    querySelector: (s) => (els[s] || [])[0] || null, querySelectorAll: (s) => els[s] || [],
  };
  const window = { innerWidth: vw, innerHeight: vh, addEventListener: noop, removeEventListener: noop, matchMedia: () => ({ matches: true }) };
  window.window = window;
  const ctx = { window, document, location: { pathname: '/dashboard.html' }, localStorage: { getItem: () => null, setItem: noop },
    getComputedStyle: (el) => (el && el._cs) || { display: 'block', visibility: 'visible', overflow: 'visible', overflowX: 'visible', overflowY: 'visible', position: 'static' },
    requestAnimationFrame: noop, setTimeout: noop, matchMedia: () => ({ matches: true }), console };
  vm.runInNewContext(r('page-tours.js') + '\n' + SRC, ctx);   // R46: page-tours.js loads just before tour.js
  return { T: window.HelmTour, document };
}
const S = (sel, title, extra) => Object.assign({ sel, title, desc: title }, extra);
const STEPS = [
  { title: 'Welcome', desc: 'hi' },
  S('#pin', 'Pin'), S('#q', 'Quotes'), S('#cal', 'Calendar'), S(['#manage', '#more'], 'Manage'), S(['#admin', '#more'], 'Admin'),
  S('#search', 'Search'), S('#eye', 'Eye'), S('#bell', 'Bell'),
  S('#setup', 'Checklist', { trial: false }),
  { title: 'Done', desc: 'bye' },
];
const desktop = () => ({
  '#pin': [target(200, 20)], '#q': [target(8, 120)], '#cal': [target(8, 160, 160, 36, { hidden: true })],          // calendar not allowed for this role
  '#manage': [target(8, 220, 220, 140)], '#admin': [target(8, 380, 220, 140)], '#more': [],
  '#search': [target(400, 12, 280)], '#eye': [target(690, 12, 36)], '#bell': [target(780, 12, 36)], '#setup': [target(300, 260, 140)],
});

t('hidden / missing targets are skipped and the counter only counts what is shown', () => {
  const { T, document } = loadTour({ els: desktop() });
  const shown = Array.from(T._shown(STEPS), (k) => STEPS[k].title);
  assert.deepEqual(shown, ['Welcome', 'Pin', 'Quotes', 'Manage', 'Admin', 'Search', 'Eye', 'Bell', 'Checklist', 'Done']);   // Calendar hidden
  let root; const ce = document.createElement; document.createElement = () => (root = ce());
  T.start(STEPS, 'k');
  const txt = () => Array.from([root.querySelector('.tstep').textContent, root.querySelector('h4').textContent, root.querySelector('.next').textContent, root.querySelector('.back').style.visibility]);
  assert.deepEqual(txt(), ['Step 1 of 10', 'Welcome', 'Next →', 'hidden']);
  root.querySelector('.next').onclick(); assert.deepEqual(txt(), ['Step 2 of 10', 'Pin', 'Next →', 'visible']);
  root.querySelector('.next').onclick(); assert.deepEqual(txt().slice(0, 2), ['Step 3 of 10', 'Quotes']);
  root.querySelector('.next').onclick(); assert.deepEqual(txt().slice(0, 2), ['Step 4 of 10', 'Manage'], 'jumps over the hidden Calendar item');
  root.querySelector('.back').onclick(); assert.deepEqual(txt().slice(0, 2), ['Step 3 of 10', 'Quotes'], 'Back skips it too');
  for (let n = 0; n < 7; n++) root.querySelector('.next').onclick();
  assert.deepEqual(txt(), ['Step 10 of 10', 'Done', 'Done', 'visible']);
});

t('a target that appears late is still visited; one that disappears mid-tour is jumped over', () => {
  const els = desktop(); const { T, document } = loadTour({ els });
  let root; const ce = document.createElement; document.createElement = () => (root = ce());
  els['#cal'] = [];                                                     // not rendered yet when the tour starts
  T.start(STEPS, 'k');
  assert.equal(root.querySelector('.tstep').textContent, 'Step 1 of 10');
  els['#cal'] = [target(8, 160)];                                       // the role-gated item arrives
  root.querySelector('.next').onclick(); root.querySelector('.next').onclick();
  root.querySelector('.next').onclick();
  assert.deepEqual([root.querySelector('h4').textContent, root.querySelector('.tstep').textContent], ['Calendar', 'Step 4 of 11']);
  els['#manage'] = []; els['#admin'] = [];                              // e.g. sidebar groups removed
  root.querySelector('.next').onclick();
  assert.equal(root.querySelector('h4').textContent, 'Search');
});

t('free trial: trial:false steps are never shown (and not counted)', () => {
  const { T, document } = loadTour({ els: desktop(), trial: true });
  assert.ok(!T._shown(STEPS).map((k) => STEPS[k].title).includes('Checklist'));
  let root; const ce = document.createElement; document.createElement = () => (root = ce());
  T.start(STEPS, 'k');
  assert.equal(root.querySelector('.tstep').textContent, 'Step 1 of 9');
  for (let n = 0; n < 7; n++) root.querySelector('.next').onclick();
  assert.equal(root.querySelector('h4').textContent, 'Bell');
  root.querySelector('.next').onclick();
  assert.deepEqual([root.querySelector('h4').textContent, root.querySelector('.tstep').textContent], ['Done', 'Step 9 of 9']);
});

t('phone: two steps that fall back to the same "More" button show it once', () => {
  const more = target(300, 760, 60, 40);
  const els = Object.assign(desktop(), { '#manage': [], '#admin': [], '#more': [more] });
  const { T } = loadTour({ els, vw: 375, vh: 812 });
  const shown = Array.from(T._shown(STEPS), (k) => STEPS[k].title);
  assert.ok(shown.includes('Manage') && !shown.includes('Admin'), shown.join());
});

t('an off-screen target is scrolled into view and the card stays hidden until it settles', () => {
  const far = target(300, 1600, 140, 40);
  const { T, document } = loadTour({ els: { '#far': [far] } });
  let root; const ce = document.createElement; document.createElement = () => (root = ce());
  T.start([S('#far', 'Far')], 'k');
  assert.equal(far.scrolled, 1, 'scrollIntoView before highlighting');
  assert.match(SRC, /root\.classList\.toggle\("htour-moving", moving\)/);
  assert.match(SRC, /\.htour\.htour-moving \.tip,\.htour\.htour-moving \.arrow\{opacity:0;pointer-events:none\}/);
  assert.match(SRC, /const reveal = \(\) => \{ if \(!root \|\| seq !== placeSeq\) return; position\(\); root\.classList\.remove\("htour-moving"\); \};/);
});

/* ---- popover never covers its target, stays on screen ---- */
const T0 = loadTour().T;
const overlaps = (L, R) => { const tp = L.tip, th = tp.maxHeight || 170; return !(tp.left + tp.width <= R.left || tp.left >= R.right || tp.top + th <= R.top || tp.top >= R.bottom); };
const onScreen = (L, vw, vh) => { const tp = L.tip, th = tp.maxHeight || 170; return tp.left >= 12 && tp.top >= 12 && tp.left + tp.width <= vw - 12 + 0.01 && tp.top + th <= vh - 12 + 0.01; };

t('layout(): side:"right" puts a sidebar item\'s card beside the rail (not over the next items)', () => {
  for (const vw of [1280, 1366, 1440]) {
    const R = rect(8, 140, 220, 36), L = T0._layout(R, vw, 800, 320, 170, 'right');
    assert.equal(L.side, 'right'); assert.ok(L.tip.left >= R.right, 'beside the rail'); assert.ok(onScreen(L, vw, 800)); assert.ok(!overlaps(L, R));
  }
  // a preferred side without room falls back to the normal order
  assert.equal(T0._layout(rect(1100, 100, 160, 36), 1280, 800, 320, 170, 'right').side, 'below');
});

t('layout(): top bar + dashboard targets at 1280-1440 and on a phone: on screen, never covering the target', () => {
  const cases = [
    [1280, 800, rect(400, 12, 280, 36)], [1440, 900, rect(1300, 12, 120, 36)], [1280, 800, rect(260, 80, 1000, 40)],
    [1280, 800, rect(260, 130, 1000, 220)], [1366, 768, rect(260, 300, 1080, 120)], [375, 812, rect(16, 200, 343, 240)],
    [375, 667, rect(16, 120, 343, 330)], [375, 812, rect(250, 20, 40, 40)], [390, 844, rect(300, 780, 60, 40)],
  ];
  for (const [vw, vh, R] of cases) {
    const L = T0._layout(R, vw, vh, 320, 170);
    assert.ok(onScreen(L, vw, vh), `on screen ${vw}x${vh} ${JSON.stringify(R)}`);
    assert.ok(!overlaps(L, R), `does not cover ${vw}x${vh} ${JSON.stringify(R)} -> ${JSON.stringify(L.tip)}`);
  }
});

t('layout(): a tall target with no full gap shrinks the card (buttons stay pinned) instead of covering it', () => {
  const R = rect(16, 170, 343, 330), L = T0._layout(R, 375, 667, 320, 170);
  assert.ok(L.tip.maxHeight >= 96 && L.tip.maxHeight < 170, 'card height capped to the free gap');
  assert.ok(!overlaps(L, R));
  assert.match(SRC, /\.htour \.tip \.trow\{[^}]*position:sticky;bottom:-16px/, 'Next / Back stay visible while the card scrolls');
  assert.match(SRC, /tip\.style\.maxHeight = L\.tip\.maxHeight \? L\.tip\.maxHeight \+ "px" : "";/);
});

/* ---- start-up: the force / seen logic is unchanged; the auto-start waits for the shell ---- */
t('auto-start keeps the force/seen rule + trial-welcome hold, and waits for the rail, the dashboard and the trial answer', () => {
  assert.match(D, /if\(seen \|\| \(!forced && \(localSeen \|\| !eligible\)\)\) return;/);
  assert.match(D, /if\(window\.HelmTrialDemo && HelmTrialDemo\.welcomeOn\) return;/);
  const w = D.slice(D.indexOf('function startTourWhenReady'), D.indexOf('$("#helpBtn").addEventListener'));
  assert.match(w, /HelmTrialLock\.whenKnown\(\)/);
  assert.match(w, /rail\.hasAttribute\("data-nav-ready"\)/);
  assert.match(w, /hd-ready/);
  assert.match(w, /Date\.now\(\)-t0>6000/, 'hard cap: never waits forever');
  assert.match(SHELL, /rail\.setAttribute\("data-nav-ready", "1"\)/);
});

console.log(`\ntour-order: ${passed} check(s) passed.`);
