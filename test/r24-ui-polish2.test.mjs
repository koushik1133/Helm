// r24 ui (owner screenshots, live site): Assign vendor dialog (Qty fits, dd/mm hint, amounts visible while typing in
// privacy mode, plain "Notes for the vendor", e-mail hint), event-day crew check-in card (plain empty state, the optional
// check-in location as a small link, location-check-off line with a Settings link), run sheet one-line intro.
// Pages and scripts are checked as text.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const tests = []; const t = (n, f) => tests.push([n, f]);
const RES = read('public/resources.html'), RCSS = read('public/resources-polish.css'), PRIV = read('public/shell-b-privacy.js'),
  CREW = read('public/crew-shifts.js'), CCSS = read('public/crew-shifts.css'), CC = read('public/control.html'),
  RS = read('public/runsheet.html'), RSCSS = read('public/runsheet-polish.css');
const dialog = RES.slice(RES.indexOf('<div id="bookModal"'), RES.indexOf('<div id="sentModal"'));

t('assign vendor: Vendor + Qty row uses a grid that cannot overflow (minmax(0,1fr) + fixed Qty column)', () => {
  assert.match(dialog, /<div class="rp-row2 rp-vq">\s*<div class="fld"><label for="bk_vendor">/);
  assert.ok(!dialog.includes('s-0a349e0'), 'old 1fr 1fr pair class gone from the dialog');
  assert.match(RCSS, /\.rp-row2\{display:grid;grid-template-columns:minmax\(0,1fr\) minmax\(0,1fr\)/);
  assert.match(RCSS, /\.rp-row2\.rp-vq\{grid-template-columns:minmax\(0,1fr\) 96px\}/);
  assert.match(RCSS, /\.rp-sheet \.fld input:not\(\[type=checkbox\]\):not\(\[type=radio\]\),\.rp-sheet \.fld select\{width:100%;min-width:0/);
});
t('assign vendor: the date box gets the studio-format day under it (BPUI.dateHint)', () => {
  assert.match(RES, /BPUI\.dateHint\(\$\("#vr_date"\)\)/);
});
t('assign vendor: Agreed amount has a placeholder (an empty box never shows dots) + privacy note', () => {
  assert.match(dialog, /id="vr_amt" type="number" min="0" step="1" inputmode="numeric" placeholder="e\.g\. 25000"/);
  assert.match(dialog, /class="rp-privnote"[^>]*>Amounts are hidden right now - tap a box to see or type the amount\./);
  assert.match(RCSS, /html\.hb-priv-on \.rp-privnote\{display:block\}/);
  assert.match(dialog, /id="bk_cost" type="number" min="0" placeholder="optional"/);
  assert.match(dialog, /id="bk_adv" type="number" min="0" placeholder="optional"/);
});
t('privacy: a masked money box with no placeholder gets a blank one, so an EMPTY box reads empty (value untouched)', () => {
  assert.match(PRIV, /if \(!i\.hasAttribute\("placeholder"\)\) i\.setAttribute\("placeholder", " "\);/);
  assert.ok(!/\.value\s*=/.test(PRIV.slice(PRIV.indexOf('function markInput'), PRIV.indexOf('var MASKED_IN'))), 'markInput never writes a value');
});
t('assign vendor: plain notes label, example placeholder and helper text', () => {
  assert.match(dialog, /<label for="vr_det">Notes for the vendor \(optional\)<\/label>/);
  assert.match(dialog, /placeholder="e\.g\. 2 photographers, candid \+ stage, contact Ravi 98xxxxxx"/);
  assert.match(dialog, /id="vr_detHint">They see this in their request<\/small>/);
  assert.ok(!RES.includes('optional - specs, contact on site'));
});
t('assign vendor: "E-mail it too" says it only goes when email is switched on', () => {
  assert.match(dialog, /id="vr_mail" checked aria-describedby="vr_mailHint"> E-mail it too<\/label><small class="rp-help" id="vr_mailHint">only when email is switched on<\/small>/);
});
t('needs table: the "from requirements" note is not clipped', () => {
  assert.match(RES, /<span class="muted rp-note">\$\{esc\(c\.note\)\}<\/span>/);
  assert.match(RCSS, /\.rp-meta \.rp-note\{white-space:nowrap\}/);
});
t('crew card: plain empty state with a Tasks & staff link', () => {
  assert.match(CREW, /"No crew on this event yet - assign people in ", opsA, "\."/);
  assert.match(CREW, /href: "ops\.html\?quote=" \+ encodeURIComponent\(q\)/);
  assert.ok(!CREW.includes('assign people on Operations'));
});
t('crew card: check-in location is a small optional link while the check is off or nobody is on the event', () => {
  assert.match(CREW, /var small = !st\.geofence \|\| !nRows;/);
  assert.match(CREW, /h\("details", \{ cls: "cs-site" \+ \(small \? " cs-site-small" : ""\) \}\)/);
  assert.match(CREW, /"📍 Set check-in location \(optional\)"/);
  assert.match(CREW, /"Location check is off - turn on in ", ccLink\(\)/);
  assert.match(CREW, /href: "control\.html#crew", cls: "cs-link", text: "Settings → Crew & shifts"/);
  assert.match(CCSS, /\.cs-site>summary\{/);
});
t('control center: #crew opens the Notifications tab at the crew settings card (admins only)', () => {
  assert.match(CC, /"#crew":"crewCfgCard"/);
  assert.match(CC, /if\(id==="crewCfgCard"\)\{ if\(\$\("#tab-notify"\)\.hidden\) return; switchTab\("notify"\); \}/);
  assert.match(CREW, /text: "Crew & shifts: availability, open shifts & check-in"/);
});
t('run sheet: one-line purpose under the title (hidden in print)', () => {
  assert.match(RS, /<p class="rs-intro" id="rsIntro">Run sheet = the minute-by-minute plan for the event day \(e\.g\. 6:00 setup, 7:00 guests arrive\)\. Each line can have an owner who gets a reminder\.<\/p>/);
  assert.match(RSCSS, /@media print\{\.rs-intro\{display:none\}\}/);
});

let failed = 0;
for (const [n, f] of tests) { try { await f(); console.log('  ✓ ' + n); } catch (e) { failed++; console.log('  ✗ ' + n + '\n    ' + (e && e.message)); } }
console.log(`r24-ui-polish2: ${tests.length - failed}/${tests.length} passed`);
if (failed) process.exit(1);
