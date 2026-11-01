// r115-masked-amounts.test.mjs - R115: every hidden amount ("Hide amounts" eye) looks the same everywhere: ONE quiet
// rounded chip (lock + "Hidden", aria-label "Amount hidden") drawn by shell-b-privacy.css on the span.hbp-mask that
// shell-b-privacy.js puts in each masked element - no more cramped "••••" on a grey box, no per-page restyles.
// Plus the placeholder audit fixes (testing/phase2/PLACEHOLDER-AUDIT.md). Static checks only.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok - ' + name); };
const CSS = read('public/shell-b-privacy.css'), JS = read('public/shell-b-privacy.js');

t('shared chip: .hbp-mask is a rounded lock + "Hidden" chip with fixed px sizes', () => {
  assert.match(CSS, /\.hbp-mask, html\.hb-priv-on :is\(\.hbp-m, \[data-money\]\) > \.hbp-mask \{[^}]*display: inline-flex !important;[^}]*border-radius: 999px;[^}]*font-size: 0 !important;/);
  assert.match(CSS, /\.hbp-mask::after \{ content: "Hidden"; font: 600 11\.5px\/1 /);
  assert.match(CSS, /\.hbp-mask::before \{[^}]*background: currentColor;[^}]*mask: url\("data:image\/svg\+xml,/);
  assert.match(CSS, /color: var\(--hb-ink2, var\(--ink-2, #3b4a45\)\) !important;/, 'muted but readable ink, not the faint ink3');
  assert.match(CSS, /border: 1px solid color-mix\(in srgb, var\(--hb-ink, #111\) 13%, transparent\);/, 'hairline border so it reads on tinted backgrounds');
});
t('shared chip: the masked element drops its own grey box + overlay dots when the chip is there', () => {
  assert.match(CSS, /html\.hb-priv-on :is\(\.hbp-m, \[data-money\]\):not\(svg\):not\(svg \*\):has\(> \.hbp-mask\) \{ background: none !important;/);
  assert.match(CSS, /:has\(> \.hbp-mask\)::after \{ content: none !important; \}/);
  assert.match(CSS, /content: "••••"; position: absolute; inset: 0;/, 'fallback overlay kept for a masked box that cannot hold the chip');
  assert.match(CSS, /\.hbp-mask, html\.hb-priv-on[^{]*\{[^}]*color: var\(--hb-ink2[^}]*!important/, 'chip beats the "children of a masked block" transparent rule');
});
t('helper: makeMask uses the ONE hiddenChip() (aria-label "Amount hidden", text "••••") and exposes it', () => {
  assert.match(JS, /function hiddenChip\(\) \{\s*var sp = document\.createElement\("span"\); sp\.className = "hbp-mask"; sp\.setAttribute\("role", "img"\); sp\.setAttribute\("aria-label", "Amount hidden"\);/);
  assert.match(JS, /var sp = hiddenChip\(\), tx = sp\.firstChild; maskTxt\.set\(tx, e\); spanOwner\.set\(sp, e\); return sp;/);
  assert.match(JS, /realText: realText, hiddenChip: hiddenChip,/);
  assert.match(JS, /var MASK = "\\u2022\\u2022\\u2022\\u2022"/, 'copy/paste + realText still use the same "••••" text');
});
t('no per-page restyle of the chip left (one shared look)', () => {
  const offenders = readdirSync(new URL('../public/', import.meta.url)).filter((f) => f.endsWith('.css') && f !== 'shell-b-privacy.css')
    .filter((f) => /\.hbp-mask[^{,]*\{/.test(read('public/' + f)) || /\.hbp-mask::(before|after)/.test(read('public/' + f)));
  assert.deepEqual(offenders, []);
  assert.match(read('public/crm-polish.css'), /html\.hb-priv-on #rows td\.hbp-m:not\(svg \*\) \{ text-align: right; \}/, 'CRM money column stays right-aligned');
  assert.match(read('public/insights-polish.css'), /html\.hb-priv-on #main td\.hbp-m \{ text-align: right; \}/);
});
t('placeholder audit: lowercase / cryptic / dev placeholders are gone', () => {
  const bad = [['closure.html', 'placeholder="who"'], ['issues.html', "placeholder=\"what's happening\""], ['issues.html', "placeholder=\"who's on it\""],
    ['logistics.html', 'placeholder="what needs doing"'], ['inventory.html', 'placeholder="who checked it"'], ['settlement.html', 'placeholder="amount"'],
    ['settlement.html', 'placeholder="name"'], ['plan.html', 'placeholder="qty"'], ['discovery.html', 'placeholder="#"'], ['command.html', 'placeholder="Exp."'],
    ['nurture.html', 'placeholder="for greetings"'], ['hq-referrals.html', '-> Studios'], ['flow.html', 'Blank = automatic'], ['builder.js', 'paste a GLB'],
    ['resources.html', 'placeholder="what this vendor brings"']];
  for (const [f, s] of bad) assert.ok(!read('public/' + f).includes(s), f + ' still has ' + s);
  for (const f of ['budget.html', 'flow.html', 'inventory.html', 'media.html', 'resources.html', 'vendors.html', 'control.html'])
    assert.ok(!read('public/' + f).includes('placeholder="optional"'), f + ': "Optional" is capitalised like the rest');
});
t('placeholder audit: money hints name the studio currency (not a hard-coded ₹)', () => {
  const C = read('public/control.html'), L = read('public/leads.html');
  assert.match(C, /function curPh\(\)\{ let sym="₹"; try\{ const r=BPStore\.studioTax\(\); sym=r\.country==="IN"\?"₹":/);
  assert.match(C, /async function renderChairs\(\)\{ curPh\(\);/); assert.match(C, /async function renderPlates\(\)\{ curPh\(\);/);
  assert.match(L, /<label for="f_budget">Budget \(<span class="cur-sym">₹<\/span>\)<\/label>/);
  assert.match(L, /document\.querySelectorAll\("#leadModal \.cur-sym"\)/);
});
console.log(`\n${n} tests passed`);
