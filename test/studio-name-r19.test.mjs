// studio-name-r19.test.mjs - after signing in you can see WHICH studio you are in:
//  * store-api: org.describe() (pure) turns the studio row + my_trial_status() into {name, initials, logo, plan};
//    org.identity() reads only the cached row + cached trial answer; a rename re-reads once and sends "helm:studio"
//  * shell-b.js: a studio row under the Helm logo in the rail + a small line under the page title on phones
//  * shell-b-dash.js: the studio label above the dashboard greeting (tour steps untouched)
//  * auth-ui.js: the profile menu header says "<role> at <Studio>" (tooltip "Signed in as ...")
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const root = new URL('..', import.meta.url).pathname;
const read = (p) => readFileSync(root + p, 'utf8');
const API = read('public/store-api.js'), SHELL = read('public/shell-b.js'), SCSS = read('public/shell-b.css');
const DASH = read('public/shell-b-dash.js'), DCSS = read('public/shell-b-dash.css'), AUI = read('public/auth-ui.js');
const tests = []; const t = (n, f) => tests.push([n, f]);

function describe() {
  const i = API.indexOf('  /* r19-studio-name (pure)'), j = API.indexOf('  /* ---------------- branded client links');
  assert.ok(i > 0 && j > i, 'helpers sit between the org object and the links block');
  const ctx = vm.createContext({});
  vm.runInContext(API.slice(i, j) + '\nthis.d = studioDescribe;', ctx);
  return ctx.d;
}
t('org.describe: name, initials, https logo only, plan chip from my_trial_status', () => {
  const d = describe();
  const a = d({ id: 'o1', name: '  Call  ·  Hyderabad ', brand: { logo: 'https://cdn.example.com/l.png' } }, { state: 'trial', status: 'trial', days_left: 12 });
  assert.equal(a.name, 'Call · Hyderabad'); assert.equal(a.initials, 'CH'); assert.equal(a.logo, 'https://cdn.example.com/l.png');
  assert.equal(a.plan.key, 'trial'); assert.equal(a.plan.label, 'Free trial'); assert.equal(a.plan.title, 'Free trial: 12 days left');
  assert.equal(d({ name: 'Studio' }, { state: 'trial', days_left: 0 }).plan.title, 'Free trial: ends today');
  assert.equal(d({ name: 'Aarav events' }, { state: 'none', status: 'active' }).plan.label, 'Paid plan');
  assert.equal(d({ name: 'x' }, { state: 'ended', status: 'trial' }).plan.label, 'Trial ended');
  assert.equal(d({ name: 'x' }, { state: 'none', status: 'past_due' }).plan.label, 'Payment due');
  assert.equal(d({ name: 'x' }, { state: 'none', status: 'suspended' }).plan.label, 'Read-only');
  assert.equal(d({ name: 'x' }, null).plan, null); assert.equal(d({ name: 'x' }, { state: 'none', status: 'cancelled' }).plan, null);
  assert.equal(d({ name: 'Ω' }).initials, 'Ω'); assert.equal(d({ name: 'ಕನ್ನಡ ಸ್ಟುಡಿಯೋ' }).initials.length, 2);
  for (const bad of ['javascript:alert(1)', 'http://x.y/a.png', 'https://x.y/a b.png', 'https://x.y/"onerror=1', 'https://' + 'a'.repeat(600)])
    assert.equal(d({ name: 'x', brand: { logo: bad } }).logo, null, bad);
  assert.equal(d({ name: '' }), null); assert.equal(d(null), null); assert.equal(d({ name: '   ' }), null);
  assert.equal(d({ name: 'n'.repeat(300) }).name.length, 120);
});
t('org.identity: cached row + cached trial only; rename re-reads once; reads emit "helm:studio" after caching', () => {
  const m = API.match(/async identity\(\) \{([\s\S]*?)\n    \},/); assert.ok(m, 'identity()');
  assert.match(m[1], /org\.current\(\)\.catch/); assert.match(m[1], /B\.subscription\.trial\(\)/); assert.ok(!/fresh/.test(m[1]), 'never a fresh read');
  assert.match(API, /if \(error\) throw error; try \{ if \(data && data\.timezone[^\n]*\n\s*studioEmit\(data\); return data; \};/);
  assert.match(API, /if \(patch && \("name" in patch \|\| "brand" in patch\)\) Promise\.resolve\(\)\.then\(\(\) => org\.current\(\{ fresh: true \}\)\)\.catch\(\(\) => \{\}\);/);
  assert.match(API, /setTimeout\(\(\) => \{ try \{ window\.dispatchEvent\(new CustomEvent\("helm:studio", \{ detail: d \}\)\); \} catch \(e\) \{\} \}, 0\);/);
  assert.match(API, /describe: \(row, trial\) => studioDescribe\(row, trial\),/);
});
t('shell rail: studio row under the Helm logo, text via textContent, live repaint, signed-out = hidden', () => {
  assert.match(SHELL, /rail\.appendChild\(top\);\n    var studio = studioRow\(\); rail\.appendChild\(studio\);/);
  assert.match(SHELL, /var row = el\("div", "hb-studio"\); row\.hidden = true;/);
  assert.match(SHELL, /row\.querySelector\("\.hb-st-n"\)\.textContent = d\.name;/);
  assert.match(SHELL, /row\.title = tip; row\.hidden = false;/);
  assert.match(SHELL, /window\.addEventListener\("helm:studio", function \(e\) \{ safe\(function \(\) \{ paint\(e\.detail\); \}\); \}\);/);
  assert.match(SHELL, /if \(!u\) \{ if \(\+\+n < 200\) setTimeout/);
  assert.ok(!/innerHTML/.test(SHELL.slice(SHELL.indexOf('r19-studio-name: which studio'), SHELL.indexOf('rail profile: from the auth'))), 'no innerHTML');
  assert.match(SHELL, /img\.addEventListener\("error", function \(\) \{ img\.hidden = true; img\.removeAttribute\("src"\);/);
});
t('shell top bar (phones): studio line under the page title, only <= 819px, ellipsis', () => {
  assert.match(SHELL, /safe\(function \(\) \{ studioCaption\(header\); \}\);/);
  assert.match(SHELL, /var c = el\("span", "hb-mstudio"\); c\.hidden = true; h\.parentNode\.appendChild\(c\);/);
  assert.match(SCSS, /header\.hb-header \.hb-mstudio \{ display: none; \}\n@media \(max-width: 819px\) \{\n  html\[data-shell="b"\] header\.hb-header \.hb-mstudio:not\(\[hidden\]\) \{ display: block; max-width: 100%;[^}]*text-overflow: ellipsis; \}/);
  assert.match(SCSS, /\.hb-st-n \{ display: block; min-width: 0;[^}]*text-overflow: ellipsis; white-space: nowrap; \}/);
  assert.match(SCSS, /\.hb-studio\[hidden\] \{ display: none; \}/);
});
t('dashboard hero: studio label above the date + greeting, plan chip, theme tokens only, tour steps untouched', () => {
  assert.match(DASH, /var stl = el\("p", "hd-studio"\); stl\.hidden = true; hl\.appendChild\(stl\);[^\n]*\n    var dl = el\("p", "hd-date hd-eyebrow"\)/);
  assert.match(DASH, /if \(!signedOut\) \(function \(\) \{/);
  assert.match(DASH, /stl\.appendChild\(el\("span", "hd-vh", "Studio: "\)\);/);
  assert.match(DASH, /S\(\)\.org && S\(\)\.org\.identity \? S\(\)\.org\.identity\(\) : null/);
  const css = DCSS.slice(DCSS.indexOf('r19-studio-name'));
  assert.ok(css.length > 100 && !/#[0-9a-fA-F]{3,8}\b/.test(css), 'tokens only');
  assert.match(css, /\.hd-st-n \{ min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;/);
  assert.match(css, /@container hd \(min-width: 760px\) \{ html\[data-shell=\"b\"\] \.hd-hero-solo \.hd-studio \{ max-width: calc\(100% - 76px\); \} \}/);
  assert.match(read('public/dashboard.html'), /\{sel:\['\[data-tour="hero"\]','#hdDash'\], title:"Your day at a glance"/);
});
t('profile menu header: "<role> at <Studio>", tooltip "Signed in as ...", rename repaints in place', () => {
  assert.match(AUI, /    menuStudioLine\(who, head, m\);   \/\/ r19-studio-name/);
  assert.ok(!/if \(m\.role\) who\.appendChild\(el\("span", \{ class: "hau-chip" \}, m\.role\)\);/.test(AUI), 'chip moved into the studio row');
  assert.match(AUI, /if \(m\.role\) row\.appendChild\(el\("span", \{ class: "hau-chip" \}, m\.role\)\);/);
  assert.match(AUI, /head\.title = "Signed in as " \+ m\.name \+ \(m\.role \? " \\u00b7 " \+ m\.role : ""\) \+ " at " \+ name;/);
  assert.match(AUI, /at\.appendChild\(el\("b", null, name\)\)/);
  assert.match(AUI, /window\.addEventListener\("helm:studio", function \(e\) \{[^\n]*menu\.studioFill\(d\.name\)/);
  assert.match(AUI, /\.hau-mh-s\{min-width:0;[^"]*text-overflow:ellipsis;white-space:nowrap\}/);
});
let pass = 0;
for (const [n, f] of tests) { try { await f(); pass++; console.log('  ok  ' + n); } catch (e) { console.log('  FAIL ' + n + '\n       ' + e.message); } }
console.log(`studio-name-r19: ${pass} passed${pass === tests.length ? '' : ', ' + (tests.length - pass) + ' FAILED'}`);
if (pass !== tests.length) process.exit(1);
