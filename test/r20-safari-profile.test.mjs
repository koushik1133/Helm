// r20 Safari / profile:
//  1) Safari (WebKit) clipped the sidebar's profile menu: the menu is position:fixed BESIDE the rail but lived INSIDE the
//     fixed, overflow:hidden rail - Chrome lets a fixed child escape that clip, WebKit does not, so in Safari a click on the
//     avatar opened a fully clipped (invisible) menu. shell-b.js now moves the menu to <body> (like the colour-theme
//     picker), the CSS styles it there, the rail is held open through html.hau-menu-open, and the name opens it too.
//  2) "Your profile: 0 of 8 details added" for a trial admin who typed name / phone / city at sign-up: the panel now
//     pre-fills empty fields from what we already have (sign-up name in user_metadata, the studio's phone / city from the
//     trial welcome) as SUGGESTIONS - nothing is written until the person presses Save.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const AUI = read('public/auth-ui.js'), SHELL = read('public/shell-b.js'), CSS = read('public/shell-b.css'), STUDIO = read('public/shell-b-theme-studio.css');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok -', name); };
const fnSrc = (src, name) => {
  const at = src.indexOf(`function ${name}(`); assert.ok(at >= 0, name + ' missing');
  let i = src.indexOf('{', src.indexOf(')', at)), depth = 0;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1); }
  throw new Error(name + ' unterminated');
};

/* ---------------- 1) Safari profile menu ---------------- */
t('the adopted account menu is moved to <body> (never left inside the clipping rail)', () => {
  const f = fnSrc(SHELL, 'acctMenuOut');
  assert.match(f, /querySelector\("\.hau-menu"\)/);
  assert.match(f, /pop\.classList\.add\("hb-acct-pop"\)/);
  assert.match(f, /document\.body\.appendChild\(pop\)/);
  // only CLOSED stale copies are dropped (an open menu is never pulled away); UI nodes only, no data
  assert.match(f, /o !== pop && o\.hidden && o\.parentNode/);
  assert.match(SHELL, /adopt\(function \(\) \{ return document\.querySelector\("#account \.hau-mw"\); \}, acctSlot, function \(w\) \{[\s\S]{0,200}acctMenuOut\(w\)/);
});
t('the rail stays open while the menu is open (html.hau-menu-open, observed on <html>)', () => {
  const f = fnSrc(SHELL, 'watchPopovers');
  assert.match(f, /root\.classList\.contains\("hau-menu-open"\)\) open = true/);
  assert.match(f, /new MutationObserver\(check\)\.observe\(root, \{ attributes: true, attributeFilter: \["class"\] \}\)/);
  // toggles only on a real change, so observing <html> class can never loop
  assert.match(f, /if \(root\.classList\.contains\("hb-rail-hold"\) !== open\) root\.classList\.toggle\("hb-rail-hold", open\)/);
});
t('the name beside the avatar opens the same menu; a press while open only closes it', () => {
  const f = fnSrc(SHELL, 'acctNameOpens');
  assert.match(f, /window\.addEventListener\("mousedown", [\s\S]*?, true\)/);
  assert.match(f, /aria-expanded"\) === "true"/);
  assert.match(f, /who\.addEventListener\("click", function \(\) \{ var b = btn\(\); if \(!b \|\| wasOpen\) \{ wasOpen = false; return; \} b\.click\(\); \}\)/);
  assert.match(SHELL, /safe\(function \(\) \{ acctNameOpens\(who, acctSlot\); \}\)/);
});
t('CSS: every account-menu rule also matches the <body> copy (.hau-menu.hb-acct-pop)', () => {
  assert.match(CSS, /\.hb-acct \.hau-menu, html\[data-shell="b"\] \.hau-menu\.hb-acct-pop \{ position: fixed !important; left: calc\(var\(--hb-wx\) \+ 10px\) !important;/);
  assert.match(CSS, /@media \(max-width: 819px\) \{ html\[data-shell="b"\] \.hb-acct \.hau-menu, html\[data-shell="b"\] \.hau-menu\.hb-acct-pop \{ left: 12px/);
  assert.match(CSS, /\.hb-acct \.hau-menu, html\[data-shell="b"\] \.hau-menu\.hb-acct-pop \{ background:/);
  assert.match(CSS, /\.hb-acct \.hau-menu, html\[data-shell="b"\] \.hau-menu\.hb-acct-pop, html\[data-shell="b"\] \.hb-recent \.htr-pop \{ left: 12px/);
  assert.match(CSS, /\.hau-menu\.hb-acct-pop, html\[data-shell="b"\] \.hb-recent \.htr-pop, html\[data-shell="b"\] \.hb-help-dlg \{ box-shadow/);
  assert.match(STUDIO, /\[data-hb-theme="studio"\] \.hau-menu\.hb-acct-pop,/);
  // on <body> it must sit above the lifted rail (z 2000) - the phone drawer lies under it
  assert.match(CSS, /html\[data-shell="b"\] \.hau-menu\.hb-acct-pop \{ z-index: 2010 !important; \}/);
});
t('CSS: the :has() lift is its own rule (Safari < 15.4 drops a whole selector list containing :has())', () => {
  assert.match(CSS, /\nhtml\[data-shell="b"\]\.hau-menu-open \.hb-rail \{ z-index: 2000 !important; \}/);
  assert.match(CSS, /\nhtml\[data-shell="b"\] \.hb-rail:has\(\.hau-menu:not\(\[hidden\]\)\) \{ z-index: 2000 !important; \}/);
  assert.doesNotMatch(CSS, /\.hau-menu-open \.hb-rail, html\[data-shell="b"\] \.hb-rail:has/);
});
t('auth-ui menu logic is unchanged and engine-neutral (references, not DOM position; no popover / anchor APIs)', () => {
  assert.match(AUI, /\(menu\.pop && menu\.pop\.contains\(t\)\) \|\| \(menu\.btn && menu\.btn\.contains\(t\)\)/);
  assert.match(AUI, /classList\.add\("hau-menu-open"\)/);
  for (const src of [AUI, SHELL]) {
    assert.doesNotMatch(src, /showPopover|togglePopover|popovertarget|anchor-name|position-anchor|scheduler\.postTask|\.findLast\(|\.toSorted\(|Object\.groupBy/);
    // requestIdleCallback is only ever used behind a feature check (Safari has none)
    const uses = src.match(/requestIdleCallback\(/g) || [];
    const guarded = src.match(/if \((?:window|global)\.requestIdleCallback\) (?:window|global)\.requestIdleCallback\(/g) || [];
    assert.equal(uses.length, guarded.length, 'unguarded requestIdleCallback');
  }
});

/* ---------------- 2) profile suggestions ---------------- */
const ctx = {};
vm.runInNewContext(fnSrc(AUI, 'profileSuggest') + '\nglobalThis.ps = profileSuggest;', ctx);
const ps = (...a) => JSON.parse(JSON.stringify(ctx.ps(...a)));
const EMPTY = { full_name: '', phone: null, city: null, complete: false };
const STUDIO_ROW = { name: 'Demo 7', location: 'Hyderabad', brand: { phone: '98765 43210', billing: { city: 'Warangal', state: 'Telangana', country: 'IN' } } };

t('trial admin: sign-up name + studio phone (as +91 E.164) + studio city are suggested', () => {
  assert.deepEqual(ps(EMPTY, { full_name: 'Priya Sharma' }, STUDIO_ROW, null, true), {
    full_name: { value: 'Priya Sharma', from: 'signup' }, phone: { value: '+919876543210', from: 'studio' }, city: { value: 'Warangal', from: 'studio' } });
});
t('a value already in the profile is never replaced', () => {
  assert.deepEqual(ps({ full_name: 'Own Name', phone: '+919000000001', city: 'Pune' }, { full_name: 'Other' }, STUDIO_ROW, null, true), {});
});
t('a teammate (not admin) only gets their own sign-up name - never the studio phone / city', () => {
  assert.deepEqual(ps(EMPTY, { name: 'Ravi K' }, STUDIO_ROW, { primary_contact_phone: '+919811111111' }, false), { full_name: { value: 'Ravi K', from: 'signup' } });
});
t('studio account (my_studio_account) primary contact + city win over the trial-welcome copy', () => {
  const r = ps(EMPTY, {}, STUDIO_ROW, { primary_contact_name: 'Anil Rao', primary_contact_phone: '+91 99887 76655', city: 'Secunderabad' }, true);
  assert.deepEqual(r, { full_name: { value: 'Anil Rao', from: 'studio' }, phone: { value: '+919988776655', from: 'studio' }, city: { value: 'Secunderabad', from: 'studio' } });
});
t('a landline / junk phone is not offered as the mobile; text is cleaned and capped', () => {
  const r = ps(EMPTY, { full_name: '  <b>Priya</b>\u0007  Sharma ' }, { brand: { phone: '040 2345 678' } }, null, true);
  assert.equal(r.phone, undefined);
  assert.equal(r.full_name.value, 'Priya Sharma');
  assert.doesNotMatch(r.full_name.value, /[<>\u0007]/);
  assert.ok(ps(EMPTY, { full_name: 'x'.repeat(80) }, null, null, false).full_name.value.length <= 50);
  assert.equal(ps(EMPTY, {}, { brand: { phone: '+91 98765 43210 ext' } }, null, true).phone, undefined);
  assert.equal(ps(EMPTY, {}, { brand: { phone: '919876543210' } }, null, true).phone.value, '+919876543210');
  assert.equal(ps(EMPTY, {}, { brand: { phone: '09876543210' } }, null, true).phone.value, '+919876543210');
});
t('nothing known -> no suggestions; bad inputs never throw', () => {
  assert.deepEqual(ps(EMPTY, {}, null, null, true), {});
  assert.deepEqual(ps(null, null, 'x', 5, true), {});
  assert.deepEqual(ps(EMPTY, { full_name: 42 }, { brand: 'nope', location: 7 }, [], true), {});
});
t('the form shows suggestions in EMPTY fields only and labels where each came from', () => {
  const f = fnSrc(AUI, 'profileForm');
  assert.match(f, /if \(x && typeof x\.value === "string" && x\.value && !String\(P\[k\] \|\| ""\)\.trim\(\)\) sug\[k\] = x;/);
  assert.match(f, /value: P\.full_name \|\| \(sug\.full_name && sug\.full_name\.value\)/);
  assert.match(f, /value: P\.phone \|\| \(sug\.phone && sug\.phone\.value\) \|\| ""/);
  assert.match(f, /value: P\.city \|\| \(sug\.city && sug\.city\.value\)/);
  assert.match(f, /Filled in from your studio details — check it, then Save\./);
  assert.match(f, /Filled in from your sign-up — check it, then Save\./);
  assert.match(f, /" suggested from sign-up — tap Save"/);
  // cleared only after a successful save
  assert.match(f, /sugClear\(\);   \/\/ r20: the suggestions are saved values now/);
});
t('nothing is written automatically: suggestions only feed the form; the panel still saves through Save', () => {
  const f = fnSrc(AUI, 'profileSuggestFor'), g = fnSrc(AUI, 'profileSuggest');
  for (const src of [f, g]) assert.doesNotMatch(src, /\.update\(|\.complete\(|\.save\(|updateAccount|rpc\(|setItem/);
  assert.match(f, /st\.org\.current\(\)/); assert.match(f, /st\.subscription\.account\(\)/);
  assert.match(f, /\/\^\(admin\|owner\)\$\/i\.test/);
  assert.match(f, /setTimeout\([\s\S]*?2500\)/);   // never blocks the panel
  const sec = fnSrc(AUI, 'profileSection');
  assert.match(sec, /profileSuggestFor\(st, p\)\.then\(function \(sg\)/);
  assert.match(sec, /suggest: sg,/);
  assert.match(sec, /nothing is saved until you do/);
});
t('versions bumped: auth-ui (store-api loader) and the shell', () => {
  const API = read('public/store-api.js'), PROTO = read('public/shell-proto.js');
  assert.ok(Number((API.match(/const AUTH_UI_VERSION = "(\d+)"/) || [])[1]) >= 44, 'AUTH_UI_VERSION bumped');
  assert.ok(Number((PROTO.match(/var SHELL_V = "(\d+)"/) || [])[1]) >= 134, 'SHELL_V bumped');
  assert.ok(Number((API.match(/shell-proto\.js\?v=(\d+)/) || [])[1]) >= 34, 'shell-proto pin bumped');
});

console.log(`\n${n} passed`);
