// Control Center shell UX (owner report, prod, trial studio, Windows Chrome ~1280px):
//  1. the "Unsaved changes in <card>" bar followed the user to other sections and appeared on Layout rules
//     without an edit -> per-section, value-compared dirty tracking (baseline = value when first touched)
//  2. "Package saved." (Menus) showed on Layout rules -> status messages are tagged with their section
//  3. the client-links auto-expire switch was squeezed to 16px and its knob covered "Au"
//  4. the settings search placeholder was cut ("Search settings, role")
//  5. Venues Metres / Feet buttons overlapped -> one segmented control
//  6. Pricing had its own Country select next to General's -> read-only "India  Change in General"
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const r = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('  ok ' + name); };

const JS = r('public/control-split.js'), CSS = r('public/control-split.css'), HTML = r('public/control.html'), VCSS = r('public/venues.css');
new Function(JS);   // parses

t('1a. dirty = value differs from the value the field had when the user first touched it', () => {
  assert.match(JS, /main\.addEventListener\("focusin",onTouch,true\); main\.addEventListener\("pointerdown",onTouch,true\);/);
  assert.match(JS, /function touch\(f\)\{[^}]*if\(!base\.has\(g\)\) base\.set\(g,fval\(g\)\)/, 'baseline taken once, at first touch (after the page filled the form)');
  assert.match(JS, /function changed\(f\)\{ return base\.has\(f\) && base\.get\(f\)!==fval\(f\); \}/, 'a field never touched (autofill, page fill) is never "changed"');
  assert.match(JS, /function onEdit\(e\)\{\s*if\(!e\.isTrusted\) return;/, 'synthetic events from page scripts never count');
  assert.match(JS, /if\(f\.type!=="radio"\|\|!f\.name\) return \[f\];/, 'radio groups are compared as a group');
});
t('1b. the bar shows only for the section on screen; other sections get a nav dot', () => {
  assert.match(JS, /var mine=current\?dirtyIn\(current\):\[\];/);
  assert.match(JS, /if\(c\.getAttribute\("data-cs-sec"\)===key\) out\.push\(c\)/);
  assert.match(JS, /a\.classList\.toggle\("cs-unsaved",on\)/);
  assert.match(CSS, /\.cs-nav a\.cs-unsaved::after\{/);
  assert.match(JS, /drawNav\(\); clearHL\(\); afterShow\(\);/, 'every section change repaints the bar');
  assert.match(JS, /drawNav\(\); afterShow\(\); return;/, 'locked (trial) sections too');
  assert.ok(!/dirty=c; barTxt/.test(JS), 'the old single global "dirty" card is gone');
});
t('1c. Save rebaselines just its part of the card; an error right after puts the edit back', () => {
  assert.match(JS, /while\(n && n!==c && !fieldsOf\(n\)\.length\) n=n\.parentElement;/);
  assert.match(JS, /rebase\(scope\); recheck\(c\); paintDirty\(\);/);
  assert.match(JS, /\[700,1800,4000\]\.forEach/);
  assert.match(JS, /var fresh=errNodes\(c\)\.filter\(function\(x\)\{ return before\.indexOf\(x\)<0; \}\)/, 'only errors that appeared after the click');
  assert.match(JS, /BPUI\.trackDirty\(\)/, 'shared beforeunload warning while something is unsaved');
  assert.match(JS, /if\(unload\)\{ if\(dirtyCards\.size\) unload\.mark\(\); else unload\.clean\(\); \}/);
  assert.match(JS, /if\(!dirtyCards\) return;/, 'deep links that open a section early do not crash');
});
t('2. status messages are scoped to the section that caused them', () => {
  assert.match(JS, /\["msg","umsg","nmsg"\]\.map/);
  assert.match(JS, /main\.addEventListener\("click",function\(e\)\{ var c=cardOf\(e\.target\); if\(c\) actionSec=c\.getAttribute\("data-cs-sec"\); \},true\);/);
  assert.match(JS, /if\(m\.firstChild\) m\.setAttribute\("data-cs-msg",actionSec\|\|current\|\|""\);/);
  assert.match(JS, /if\(leaving && !m\.querySelector\("\.err,\[role=alert\]"\)\)\{ m\.textContent="";/, 'a success note is dropped on leaving; an error waits on its section');
  assert.match(JS, /m\.classList\.add\("cs-off"\);/);
});
t('3. the auto-expire switch keeps its 42px size inside the Control Center cards', () => {
  assert.match(CSS, /#app\.cs-on \.cs-main \.card \.lxtoggle input\[type=checkbox\]\[role=switch\]\{width:42px;height:24px;min-width:42px;min-height:24px;flex:0 0 42px/);
  assert.match(CSS, /\.lxstate small\{[^}]*border-radius:999px/);
  assert.match(HTML, /' <small>Not saved yet<\/small>'/);
});
t('4. the search placeholder fits the 232px side column', () => {
  assert.match(JS, /qi\.placeholder="Search settings\\u2026";/);
  assert.ok(!/roles, pages\\u2026/.test(JS));
  assert.match(JS, /qi\.title="Search settings, roles and pages"/);
});
t('5. Metres / Feet is one segmented control that never shrinks', () => {
  assert.match(VCSS, /\.vn-unit\{display:inline-flex;flex:none;[^}]*border-radius:10px/);
  assert.match(VCSS, /\.vn-unit:not\(#_\) \.btn\{flex:none;min-width:max-content;[^}]*white-space:nowrap/);
  assert.match(VCSS, /\.vn-unit:not\(#_\) \.btn\.on,/);
});
t('6. Pricing shows the country read-only; General is the one place to change it', () => {
  assert.match(HTML, /<select id="p_country" hidden aria-hidden="true" tabindex="-1"/);
  assert.match(HTML, /<b id="p_countryName">India<\/b> <button type="button" class="p-cgo" id="p_countryGo">Change in General<\/button>/);
  assert.match(HTML, /nm\.textContent=r\.countryName\|\|T\.profile\(r\.country\)\.name\|\|r\.country;/);
  assert.match(HTML, /\$\("#p_countryGo"\)\.addEventListener\("click"/);
  assert.match(CSS, /html\.helm-trial #app \.p-cro \.p-cgo\{display:none\}/, 'trial: General is locked, so no jump link');
  assert.match(CSS, /#p_country\[hidden\]\{display:none !important\}/);
  // the pricing save still writes the studio's (General) country, never a different one
  assert.match(HTML, /cc\.value=BPStore\.tax\.code\(p\.taxCountry\|\|"IN"\)/);
  assert.match(HTML, /\$\("#p_country"\)\.value=newCountry;/);
});
t('version pins bumped', () => {
  assert.match(HTML, /control-split\.js\?v=13/);
  assert.match(HTML, /control-split\.css\?v=8/);
  assert.match(HTML, /venues\.css\?v=4/);
});
console.log(`cc-unsaved-layout: ${n} passed`);
