#!/usr/bin/env node
/* page-tours.test.mjs — R46 "Tour this page" on every page.
 *  1. page-tours.js: section-aware lookup (Settings section on screen > URL #hash > Pricing), seen keys.
 *  2. tour.js runs the page's (section's) tour from page-tours.js: role / plan skipping, "seen" remembered
 *     per page + section, the shell fallback when nothing of the page is on screen, never auto-starts.
 *  3. The entry points: the top-bar "?" is a help menu with "Tour this page"; the sidebar item; the shortcuts
 *     sheet ("? then T", plus a button); pages without the shell get the "? Tour" button (booklet: members only).
 *  4. Accessibility: menu roles / keys, Esc, focus back to the "?", reduced motion; Roles & access tour content.
 * Pure Node: the real files run in a small stubbed DOM (node:vm). */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const r = (p) => readFileSync(join(ROOT, 'public', p), 'utf8');
const PTSRC = r('page-tours.js'), TSRC = r('tour.js'), SHELL = r('shell-b.js'), SCSS = r('shell-b.css');
let passed = 0;
const pending = [];
const t = (n, f) => pending.push([n, f]);

/* ---- stubbed DOM ---- */
function fake() {
  const kids = {}, cls = new Set(), attrs = {};
  return {
    style: {}, textContent: '', offsetWidth: 320, offsetHeight: 170, innerHTML: '',
    classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c), toggle: (c, on) => (on === undefined ? (cls.has(c) ? cls.delete(c) : cls.add(c)) : on ? cls.add(c) : cls.delete(c)), contains: (c) => cls.has(c) },
    setAttribute: (k, v) => { attrs[k] = v; }, getAttribute: (k) => attrs[k],
    addEventListener() {}, removeEventListener() {}, appendChild() {}, remove() {}, focus() {}, contains: () => false,
    querySelector(sel) { return kids[sel] || (kids[sel] = fake()); }, querySelectorAll: () => [],
  };
}
const rect = (left, top, w, h) => ({ left, top, width: w, height: h, right: left + w, bottom: top + h });
const target = (x, y, w = 160, h = 36, o = {}) => Object.assign({ hidden: false, closest: () => null, parentElement: null,
  getBoundingClientRect: () => rect(x, y, w, h), scrollIntoView() {} }, o);
function load({ path = '/control.html', hash = '', cur = null, els = {}, auth = null, withData = true } = {}) {
  const noop = () => {}, store = {}, appended = [];
  const main = cur ? { getAttribute: (k) => (k === 'data-cs-cur' ? cur : null) } : null;
  const document = {
    readyState: 'complete', hidden: false, head: { appendChild: (n) => appended.push(n) }, body: { appendChild: noop },
    documentElement: { clientWidth: 1280, clientHeight: 800, classList: { contains: () => false, toggle: noop } }, activeElement: null,
    createElement: fake, getElementById: () => null, addEventListener: noop, removeEventListener: noop,
    querySelector: (s) => (s === '.cs-main[data-cs-cur]' ? main : (els[s] || [])[0] || null), querySelectorAll: (s) => els[s] || [],
  };
  const location = { pathname: path, hash };
  const window = { innerWidth: 1280, innerHeight: 800, addEventListener: noop, removeEventListener: noop, matchMedia: () => ({ matches: true }), location, document };
  window.window = window; if (auth) window.BPStore = { auth };
  const ctx = { window, document, location, localStorage: { getItem: (k) => store[k] || null, setItem: (k, v) => { store[k] = String(v); } },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', overflow: 'visible', overflowX: 'visible', overflowY: 'visible', position: 'static' }),
    requestAnimationFrame: noop, setTimeout: noop, matchMedia: () => ({ matches: true }), console };
  vm.runInNewContext((withData ? PTSRC + '\n' : '') + TSRC, ctx);
  return { T: window.HelmTour, P: window.HelmPageTours, document, store, appended, window };
}
const tick = () => new Promise((res) => setImmediate(res));
function capture(document) { const box = {}; const ce = document.createElement; document.createElement = () => (box.root = ce()); return box; }

/* ---------------------------------------------------------------- 1. data */
t('Settings: the tour follows the section on screen, then the URL #hash, then Pricing', () => {
  const titles = (P) => Array.from(P.stepsFor('control'), (s) => s.title);
  assert.equal(load({ cur: 'access' }).P.sectionOf('control.html'), 'access');
  assert.match(titles(load({ cur: 'access' }).P)[0], /Pick a role/);
  assert.equal(load({ hash: '#payment-schedules' }).P.sectionOf('control'), 'payments', 'hash before the split has drawn');
  assert.equal(load({ hash: '#crew' }).P.sectionOf('control'), 'crew');
  assert.equal(load({ hash: '#notifications', cur: 'venues' }).P.sectionOf('control'), 'venues', 'the section on screen wins over the hash');
  assert.equal(load().P.sectionOf('control'), 'pricing', 'no section yet: Pricing (the first tab)');
  assert.equal(load({ cur: 'no-such' }).P.sectionOf('control'), 'pricing', 'unknown section: Pricing');
  assert.equal(load().P.sectionOf('quotes'), null, 'pages without sections');
});

t('seen keys: one per page, one per Settings section (builder key unchanged)', () => {
  const { P } = load();
  assert.equal(P.seenKey('builder'), 'helm_tour_seen_builder');
  assert.equal(P.seenKey('builder.html'), 'helm_tour_seen_builder');
  assert.equal(P.seenKey('control', 'access'), 'helm_tour_seen_control_access');
  assert.equal(P.seenKey('invite-studio'), 'helm_tour_seen_invite-studio');
  assert.match(r('builder.js'), /const BUILDER_TOUR_SEEN='helm_tour_seen_builder';/);
});

t('Roles & access tour: view vs ✎ edit, admin always full, the Finance switches', () => {
  const A = load().P.stepsFor('control', 'access');
  assert.ok(A.length >= 5 && A.length <= 8);
  const by = (sel) => A.find((s) => [].concat(s.sel).includes(sel));
  assert.match(by('#roleTabs').desc, /role/);
  assert.match(by('#roleTabs .rtab[data-role="admin"]').title, /Admin always has full access/);
  assert.match(by('#matrix .chip:not(.perm) .cview').desc, /see it/);
  assert.match(by('#matrix .chip:not(.perm) .pen').title, /✎ Edit/);
  assert.match(by('#matrix .chip:not(.perm) .pen').desc, /change things/);
  assert.match(by('#matrix .chip[data-area="discount_approve"]').title, /Finance: approve discounts/);
  assert.match(by('#matrix .chip[data-area="discount_approve"]').desc, /Nobody can approve their own/);
  assert.match(by('#matrix .chip[data-area="close_owed"]').title, /Finance: close with money owed/);
  assert.match(by('#matrix .chip[data-area="close_owed"]').desc, /reason/);
  // the Finance permissions the steps point at are real access-matrix areas
  const S = r('store-api.js');
  assert.match(S, /key: "discount_approve", label: "Approve discounts \(price decreases\)"[^}]*group: "Finance", permission: true/);
  assert.match(S, /key: "close_owed", +label: "Close events with money owed"[^}]*group: "Finance", permission: true/);
});

t('the dashboard keeps its own first-run tour; the booklet tour is for signed-in members only', () => {
  const { P } = load();
  assert.equal(P.entry('dashboard').own, '#helpBtn');
  assert.deepEqual(Array.from(P.stepsFor('dashboard')), []);
  assert.equal(P.entry('booklet').signedIn, true);
  assert.ok(P.stepsFor('booklet').length >= 4);
});

/* ---------------------------------------------------------------- 2. engine */
t('startPage runs this section\'s tour, skips what is not on screen, and remembers it as seen for that section', async () => {
  const els = { '#roleTabs': [target(300, 120, 600, 40)], '#matrix': [target(300, 180, 600, 400)],
    '#matrix .chip:not(.perm) .pen': [target(500, 200, 24, 24)] };   // admin tab / Finance chips not drawn for this role
  const { T, document, store } = load({ cur: 'access', els });
  const box = capture(document);
  assert.equal(T.section, 'access'); assert.equal(T.seenKey, 'helm_tour_seen_control_access');
  assert.equal(T.pageSeen(), false);
  T.startPage([{ title: 'Shell', desc: 'shell tour' }], 'helm_tour_shell'); await tick(); await tick();
  const h = () => box.root.querySelector('h4').textContent;
  assert.equal(h(), 'Pick a role'); assert.equal(box.root.querySelector('.tstep').textContent, 'Step 1 of 3');
  box.root.querySelector('.next').onclick(); assert.equal(h(), '✎ Edit', 'missing targets skipped');
  box.root.querySelector('.next').onclick(); assert.equal(h(), 'Saved straight away');
  assert.equal(box.root.querySelector('.next').textContent, 'Done');
  box.root.querySelector('.next').onclick();
  assert.equal(store.helm_tour_seen_control_access, '1'); assert.equal(T.pageSeen(), true);
  assert.equal(store.helm_tour_seen_control, undefined, 'seen per section, not for the whole page');
});

t('startPage falls back to the shell tour when nothing of the page is on screen (never a dead button)', async () => {
  const { T, document, store } = load({ path: '/quotes.html', els: { '#shellThing': [target(10, 10)] } });
  const box = capture(document);
  T.startPage([{ sel: '#shellThing', title: 'Shell', desc: 'shell tour' }], 'helm_tour_shell'); await tick(); await tick();
  assert.equal(box.root.querySelector('h4').textContent, 'Shell');
  box.root.querySelector('.next').onclick();
  assert.equal(store.helm_tour_shell, '1');
});

t('role gating: a need step is skipped for a role without that access (same BPStore.auth checks as the page)', async () => {
  const auth = { canView: async (a) => a !== 'finance', canEditArea: async () => true, can: async () => true };
  const els = { '#evHead': [target(0, 60, 900, 80)], '#paySchedCard': [target(0, 300, 900, 200)], '#filesPanel': [target(0, 520, 900, 120)] };
  const { T, document } = load({ path: '/event.html', els, auth });
  const box = capture(document);
  T.startPage([], ''); await tick(); await tick();
  const seen = []; for (let n = 0; n < 4 && box.root; n++) { seen.push(box.root.querySelector('h4').textContent); box.root.querySelector('.next').onclick(); }
  assert.ok(seen.includes('This event') && seen.includes('Files'));
  assert.ok(!seen.includes('Payments'), 'the finance-only step is skipped');
});

t('the engine loads page-tours.js on demand when a page did not include it', async () => {
  const { T, appended } = load({ path: '/inbox.html', withData: false });
  assert.equal(T.hasSteps, false);
  T.startPage([], '');
  assert.ok(appended.some((n) => n.src && /^\/page-tours\.js\?v=\d+$/.test(n.src)), 'requests /page-tours.js');
  assert.match(TSRC, /const PT_V = "\d+";/);
});

t('never auto-starts: tour.js mount only wires a button; first-run tours stay on the dashboard and builder', () => {
  const mount = TSRC.slice(TSRC.indexOf('function mount()'), TSRC.indexOf('window.HelmTour = {'));
  assert.doesNotMatch(mount.replace(/addEventListener\("click", \(\) => start\(\)\)/g, '').replace(/start\(form\.steps, form\.key\)/, ''), /\bstart(Page)?\(/);
  assert.match(SHELL, /if \(typeof T\.startPage === "function"\) T\.startPage\(shell, "helm_tour_shell"\);/);
});

/* ---------------------------------------------------------------- 3. entry points */
t('top bar "?" is the shared help menu: Tour this page + Keyboard shortcuts', () => {
  const fn = SHELL.slice(SHELL.indexOf('function helpMenu(wrap, btn)'), SHELL.indexOf('function quickCreate('));
  assert.match(fn, /menu\.setAttribute\("role", "menu"\)/);
  assert.match(fn, /btn\.setAttribute\("aria-haspopup", "menu"\); btn\.setAttribute\("aria-expanded", "false"\); btn\.setAttribute\("aria-controls", menu\.id\);/);
  assert.match(fn, /el\("span", null, "Tour this page"\)/);
  assert.match(fn, /el\("span", null, "Keyboard shortcuts"\)/);
  assert.match(fn, /tourMi\.setAttribute\("role", "menuitem"\)/);
  assert.match(fn, /tourMi\.addEventListener\("click", function \(\) \{ close\(true\); safe\(startTour\); \}\);/, 'focus goes back to the "?" before the tour starts');
  assert.match(fn, /keysMi\.addEventListener\("click", function \(\) \{ close\(true\); safe\(helpOpen\); \}\);/);
  assert.match(fn, /if \(e\.key === "Escape"\) \{ e\.preventDefault\(\); e\.stopPropagation\(\); close\(true\); \}/);
  assert.match(fn, /ArrowDown[\s\S]*ArrowUp[\s\S]*Home[\s\S]*End/);
  assert.match(fn, /nw\.hidden = !\(T && typeof T\.pageSeen === "function" && !T\.pageSeen\(\)\)/, '"New" until this page\'s tour was seen');
  assert.match(SCSS, /html\[data-shell="b"\] \.hb-hwrap \{ position: relative; display: inline-flex; \}/);
});

t('sidebar item reads "Tour this page" (the phone "More" menu shows the same rail)', () => {
  assert.match(SHELL, /tourBtn\.appendChild\(el\("span", "hb-lb", "Tour this page"\)\);/);
  assert.match(SHELL, /tourBtn\.addEventListener\("click", function \(\) \{ safe\(startTour\); \}\);/);
});

t('keyboard: "?" then "T" starts the tour; the shortcuts sheet lists it and has a Tour this page button', () => {
  assert.match(SHELL, /\["\? T", "Tour this page"\]/);
  assert.match(SHELL, /if \(e\.key === "\?"\) \{ e\.preventDefault\(\); helpOpen\(\); helpAt = Date\.now\(\); return; \}/);
  assert.match(SHELL, /\(e\.key === "t" \|\| e\.key === "T"\) && !e\.metaKey && !e\.ctrlKey && !e\.altKey && !q\.value && helpAt && Date\.now\(\) - helpAt < 1500/);
  assert.match(SHELL, /helpClose\(\); safe\(startTour\); return;/);
  assert.match(SHELL, /var tb = el\("button", "hb-help-tour", "Tour this page"\)/);
});

t('pages without the app shell: builder, HQ and the booklet get the "? Tour" button', () => {
  for (const f of ['builder.html', 'hq.html', 'booklet.html']) assert.match(r(f), /page-tours\.js\?v=\d+"><\/script>\n<script src="\/?tour\.js\?v=/, f);
  assert.match(TSRC, /if \(ent && ent\.signedIn\) \{/);
  assert.match(TSRC, /fab\.setAttribute\("aria-label", "Tour this page"\)/);
  assert.match(TSRC, /@media print\{\.htour,\.htour-fab\{display:none!important\}\}/);
});

/* ---------------------------------------------------------------- 4. a11y + motion */
t('accessible: dialog card, Esc closes, focus kept in the card and returned; reduced motion respected', () => {
  assert.match(TSRC, /role="dialog" aria-modal="false" aria-label="Guided tour"/);
  assert.match(TSRC, /if \(e\.key === "Escape"\) \{ if \(!otherModalOpen\(\)\) \{ e\.preventDefault\(\); e\.stopPropagation\(\); end\(\); \} return; \}/);
  assert.match(TSRC, /opener\.focus\(\{ preventScroll: true \}\)/);
  assert.match(TSRC, /@media \(prefers-reduced-motion:reduce\)\{\.htour \.arrow\{animation:none\}\.htour \.tip\{transition:none\}\}/);
  assert.match(TSRC, /matchMedia\("\(prefers-reduced-motion: reduce\)"\)\.matches/);
});

for (const [n, f] of pending) { await f(); passed++; console.log('  ✓ ' + n); }
console.log(`page-tours: ${passed} checks OK`);
