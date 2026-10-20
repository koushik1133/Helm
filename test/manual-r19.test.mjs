#!/usr/bin/env node
// R19 (fix/r19-tour-menu-manual): product tour pin step, trimmed profile menu, rebuilt user manual.
//  1. tour: a sidebar step opens a slim desktop rail (html.htour-rail) so the "Keep the sidebar open" ring sits on
//     the PIN, not on the logo the invisible pin overlapped; cleared on non-rail steps and when the tour ends.
//  2. profile menu: Profile, Account settings, User manual (new tab), Sign out - no Control Center / Insights /
//     Customize dashboard (the sidebar and the dashboard have them). Control Center links the manual under Help.
//  3. manual source docs/manual/USER-MANUAL.html covers every feature chapter with a contents list; every
//     "Screenshot to add" box is in the capture TODO list (scripts/manual-capture.mjs SHOTS); /manual swaps a box
//     for the picture once it is uploaded. Pure Node, no deps.
import { readFileSync, existsSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
const stripComments = (s) => { let prev; do { prev = s; s = s.replace(/<!--[\s\S]*?-->/g, ''); } while (s !== prev); const open = s.indexOf('<!--'); return open < 0 ? s : s.slice(0, open); };   // repeat until stable; an unterminated "<!--" hides the rest (CodeQL js/incomplete-multi-character-sanitization)
const root = new URL('..', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('ok -', name); };
const fnSrc = (src, name) => {
  const at = src.indexOf(`function ${name}(`); assert.ok(at >= 0, name + ' missing');
  let i = src.indexOf('{', src.indexOf(')', at)), depth = 0;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1); }
  throw new Error(name + ' unterminated');
};
const TOUR = read('public/tour.js'), DASH = read('public/dashboard.html'), AUI = read('public/auth-ui.js');
const SHELL = read('public/shell-b.js'), CS = read('public/control-split.js'), CSS_CS = read('public/control-split.css');
const MJS = read('public/manual.js'), MAN = stripComments(read('docs/manual/USER-MANUAL.html'));   // markup only (the header comment shows examples)

// ---------------------------------------------------------------- 1. tour
await t('tour: rail steps open the slim desktop rail without animation; tuck + end clear it', () => {
  assert.match(TOUR, /function openRail\(on\) \{[\s\S]*?classList\.toggle\("htour-rail", !!on\)/);
  assert.match(TOUR, /tuckRail\(!\(tgt && tgt\.closest && tgt\.closest\("#hbRail"\)\)\);\n    openRail\(!!\(tgt && tgt\.closest && tgt\.closest\("#hbRail"\)\)\);/);
  assert.match(fnSrc(TOUR, 'end'), /tuckRail\(false\);\n    openRail\(false\);/);
  assert.match(TOUR, /@media \(min-width:820px\)\{html\.htour-rail:not\(\.hb-pinned\) \.hb-rail\{width:var\(--hb-wx\)!important;transition:none!important/);
  assert.match(TOUR, /html\.htour-rail:not\(\.hb-pinned\) \.hb-rail :is\(\.hb-lb,\.hb-head,\.hb-pin\)\{opacity:1!important;transition:none!important\}/);
  // the open-rail rule comes after the tuck rule (a sidebar step clears the tuck first anyway)
  assert.ok(TOUR.indexOf('html.htour-rail') > TOUR.indexOf('html.htour-tuck:not(.hb-pinned) .hb-rail{'));
});
await t('tour: openRail drives the class on the document element (vm)', () => {
  const cls = new Set();
  const ctx = { document: { documentElement: { classList: { toggle: (c, on) => { if (on) cls.add(c); else cls.delete(c); } } } } };
  vm.runInNewContext(fnSrc(TOUR, 'openRail') + '\nglobalThis.o = openRail;', ctx);
  ctx.o(true); assert.ok(cls.has('htour-rail'));
  ctx.o(false); assert.ok(!cls.has('htour-rail'));
});
await t('dashboard tour: step 2 targets the pin; getting-started falls back to the Get set up strip', () => {
  const block = DASH.slice(DASH.indexOf('const TOUR=['), DASH.indexOf('];', DASH.indexOf('const TOUR=[')));
  const steps = block.split('\n').filter((l) => /^\s*\{.*title:/.test(l));
  assert.match(steps[1], /sel:'\[data-tour="pin"\]', side:"right", title:"Keep the sidebar open"/);
  assert.match(SHELL, /pin\.setAttribute\("data-tour", "pin"\)/);
  assert.match(block, /\{sel:\['\[data-tour="setup"\]','\[data-tour="checklist"\]','#hdGetSet'\], trial:false, title:"Getting started checklist"/);
  assert.match(read('public/shell-b-dash.js'), /getSet\.id = "hdGetSet"/);
  // r20 coord (e): the manual is hidden for now - the step only mentions it while HELM_FEATURES.manual is true
  assert.match(block, /title:"Your profile menu", get desc\(\)\{ return \(window\.HELM_FEATURES&&window\.HELM_FEATURES\.manual===true\)\?"Your account, settings, the user manual and sign out live here\.":"Your account, settings and sign out live here\."; \}\}/);
});

// ---------------------------------------------------------------- 2. profile menu
await t('profile menu: account items only, manual (when HELM_FEATURES.manual is on) opens in a new tab (noopener)', () => {
  const ctx = { S: () => ({ auth: { admin: { roleLabel: (r) => r } } }), window: { HELM_FEATURES: { manual: true } } };
  vm.runInNewContext('var AV_COLORS = 8;\n' + ['initials', 'avColorIdx', 'menuModel'].map((f) => fnSrc(AUI, f)).join('\n') + '\nglobalThis.mm=menuModel;', ctx);
  for (const role of ['admin', 'manager', 'sales', 'crew', null]) {
    const m = JSON.parse(JSON.stringify(ctx.mm({ id: 'u', email: 'a@b.test' }, {}, role, true, true)));
    assert.equal(m.items.map((i) => i.id).join(','), 'profile,settings,manual,suggest,signout', String(role));
    const man = m.items.find((i) => i.id === 'manual');
    assert.equal(man.href, 'manual.html'); assert.equal(man.newTab, true); assert.equal(man.label, 'User manual');
  }
  // r20 coord (e): hidden for now - flag off (or missing) = no manual item
  ctx.window = { HELM_FEATURES: { manual: false } };
  assert.equal(ctx.mm({ id: 'u' }, {}, 'admin', true).items.map((i) => i.id).join(','), 'profile,settings,suggest,signout');
  const menu = fnSrc(AUI, 'menuModel').replace(/\/\/.*$/gm, '');   // code only, not the comment
  assert.doesNotMatch(menu, /control|insights|customize/i);
  assert.match(fnSrc(AUI, 'buildPop'), /it\.newTab \? \{ href: it\.href, class: "hau-mi", role: "menuitem", tabindex: "-1", target: "_blank", rel: "noopener noreferrer" \}/);
  assert.doesNotMatch(fnSrc(AUI, 'refreshMenuIdentity'), /canView\("(controls|insights)"\)/);
});
await t('profile menu: no "Customize dashboard" injection; the dashboard keeps its own Customize button', () => {
  assert.doesNotMatch(SHELL, /function customizeItem|customizeItem\(|hb-customize/);
  assert.match(read('public/shell-b-dash.js'), /czBtn\.setAttribute\("data-tour", "customize"\)/);
  // Control Center + Insights are still reachable from the sidebar
  assert.match(SHELL, /\[ins, "insights", "Insights", "insights\.html", "insights"\]/);
  assert.match(read('public/store-api.js'), /\{ key: "controls",\s+label: "Control Center",\s+icon: "⚙", page: "control\.html"/);
});
await t('Account settings stay for everyone (no trial gate on the menu items)', () => {
  assert.doesNotMatch(fnSrc(AUI, 'menuModel').replace(/\/\/.*$/gm, ''), /trial/i);
  assert.match(fnSrc(AUI, 'runItem'), /if \(id === "settings"\) return openAccount\(\{ section: "settings" \}\);/);
});
await t('Control Center: Help -> User manual (new tab, #control), visible on phones too', () => {
  assert.match(CS, /var help=el\("div","cs-help"\); help\.appendChild\(el\("h4","cs-group-h","Help"\)\);/);
  assert.match(CS, /hl\.href="manual\.html#control"; hl\.target="_blank"; hl\.rel="noopener noreferrer";/);
  // r20 coord (e): the Help group is only added while HELM_FEATURES.manual is true (hidden for now)
  assert.match(CS, /if\(f===true\)\{ aside\.appendChild\(help\); return; \} if\(f!=="admin"\) return;/);
  assert.match(CSS_CS, /\.cs-help\{display:flex/);
  const mobile = CSS_CS.slice(CSS_CS.indexOf('@media (max-width:820px)'));
  assert.doesNotMatch(mobile, /\.cs-help\{display:none/);
  assert.doesNotMatch(CS, /innerHTML/);
});

// ---------------------------------------------------------------- 3. manual
const CHAPTERS = ['intro', 'trial', 'around', 'dashboard', 'leads', 'quote', 'client', 'event', 'builder', 'inventory', 'vendors',
  'staff', 'venues', 'calendar', 'chat', 'eventday', 'budget', 'settle', 'control', 'roles', 'billing', 'after', 'faq'];
await t('manual: every chapter exists once and is in the contents list and the sidebar', () => {
  const toc = MAN.slice(MAN.indexOf('<div class="toc">'), MAN.indexOf('</div>', MAN.indexOf('<div class="toc">')));
  const side = MAN.slice(MAN.indexOf('<nav'), MAN.indexOf('</nav>'));
  for (const id of CHAPTERS) {
    assert.equal((MAN.match(new RegExp(`<h2 id="${id}"`, 'g')) || []).length, 1, id);
    assert.ok(toc.includes(`href="#${id}"`), 'toc ' + id); assert.ok(side.includes(`href="#${id}"`), 'nav ' + id);
  }
  for (const m of MAN.matchAll(/href="#([\w-]+)"/g)) assert.ok(MAN.includes(`id="${m[1]}"`), 'dangling #' + m[1]);
});
await t('manual: covers the R19 feature list in plain words', () => {
  for (const s of ['8 days free', 'up to <b>2 new records in each list</b>', 'Invite <b>up to 2 teammates</b>', 'Test mode', 'one extension of up to 7 days',
    'Continue where you left off', '1 · Client &amp; event', '8 · Quotation', 'Send for approval', 'Record advance', 'In progress',
    'Lead · Discovery', 'Event Day', 'Only 20 free, short by 10', 'Vendor bills &amp; payouts', 'Save and invite to sign in', 'Control Center → Venues',
    '<b>Events</b> — which event is on when', '<b>Team</b> — who is working when', 'Create event group', 'Suggested', 'Close &amp; archive',
    'Users &amp; invites', 'Roles &amp; access', 'Hide amounts (privacy PIN)', 'Layout templates', 'Starter', 'Studio', 'Enterprise',
    'Read-only after 8 days', 'Data kept 60 days', 'Account settings', '<b>User manual</b> — opens this manual in a new tab', 'Help → User manual'])
    assert.ok(MAN.includes(s), 'manual mentions ' + s);
  assert.doesNotMatch(MAN, /Light \/ dark mode|<script/i);   // dark mode is off; the page is sanitised anyway
});
await t('manual: real pictures exist; every placeholder is in the capture TODO list', async () => {
  for (const m of MAN.matchAll(/<img [^>]*src="screenshots\/([^"]+)"/g))
    assert.ok(existsSync(new URL('docs/manual/screenshots/' + m[1], root)), 'missing screenshot ' + m[1]);
  const { SHOTS } = await import(new URL('scripts/manual-capture.mjs', root));
  const names = new Set(SHOTS.map((s) => s.name));
  const boxes = [...MAN.matchAll(/<div class="shot-todo" data-shot="([^"]+)" data-alt="[^"]+"><b>Screenshot to add<\/b>/g)].map((m) => m[1]);
  assert.ok(boxes.length >= 12, 'placeholders: ' + boxes.length);
  assert.equal(boxes.length, (MAN.match(/data-shot="/g) || []).length - 0, 'every data-shot is a well-formed box');
  for (const b of boxes) { assert.ok(names.has(b), 'TODO list has ' + b); assert.match(b, /^[\w.-]+\.(webp|png|jpe?g)$/); }
  for (const s of SHOTS) { assert.ok(boxes.includes(s.name), 'manual has a box for ' + s.name); assert.ok(s.caption && s.path.startsWith('/')); }
  const cap = read('scripts/manual-capture.mjs');
  assert.doesNotMatch(cap, /\.fill\(|\.type\(|password/i, 'the owner signs in by hand: the script never types');
  assert.match(cap, /new URL\('\.\.\/docs\/manual\/screenshots\/', import\.meta\.url\)/);
});
await t('/manual swaps a placeholder for its uploaded picture (bucket names only), after sanitising', () => {
  assert.match(MJS, /doc\.querySelectorAll\("\[data-shot\]"\)\.forEach/);
  assert.match(MJS, /\/\^\[\\w\.-\]\+\\\.\(webp\|png\|jpe\?g\)\$\/i\.test\(name\) \? res\.files\["screenshots\/" \+ name\] : null/);
  assert.ok(MJS.indexOf('sanitize(doc);') < MJS.indexOf('querySelectorAll("[data-shot]")'), 'swap runs after sanitize');
  assert.doesNotMatch(MJS, /innerHTML/);
});
await t('manual: one-line link targets and labels used by the app', () => {
  assert.match(read('public/search-catalog.js'), /\{ key: "manual",\s+label: "User manual",\s+href: "manual\.html",\s+gate: \{ feature: "manual" \}/);
  assert.match(read('public/store-api.js'), /const NEXT_PAGES = \[[^\]]*"manual"/);
});
console.log(`\nmanual-r19: ${n} passed`);
