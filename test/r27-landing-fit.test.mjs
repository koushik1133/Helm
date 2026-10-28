// r27 landing fit (owner decision): the landing stays exactly as live - same sections, content, colours and
// format - and only gets (1) one-screen fit via spacing / scale (clamp + whole-block zoom from home.js) and
// (2) clean scroll snapping on laptops / desktops / tablets. Phones keep the natural flow.
// Pixel checks at every resolution are done with headless Chromium (see the commit message).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log('  ✓ ' + name); };

const INDEX = read('public/index.html'), CSS = read('public/home.css'), JS = read('public/home.js');
const fit = CSS.slice(CSS.indexOf('r27 landing fit'), CSS.indexOf('===== version C:'));   // version C's arrangement block is checked below
const fitJs = JS.slice(JS.indexOf('r27 landing fit: one section'));

t('snapping: mandatory y-snap on >= 768 x 560 with motion allowed; plain sections + chapter points snap', () => {
  assert.match(fit, /@media \(min-width:768px\) and \(min-height:560px\) and \(prefers-reduced-motion:no-preference\)\{\n html\{scroll-snap-type:y mandatory\}/);
  assert.match(fit, /main>\.sec,main>\.fillsec,main>\.final\{scroll-snap-align:start;scroll-snap-stop:always\}/);
  assert.match(fit, /\.snap-pt\{scroll-snap-align:start;scroll-snap-stop:always\}/);
});

t('fit: one viewport per plain section; content scaled as a whole (zoom), never hidden', () => {
  assert.match(fit, /main>\.sec,main>\.fillsec,main>\.final\{min-height:100vh;min-height:100dvh;/);
  assert.match(fitJs, /k\.style\.setProperty\('zoom'/);
  assert.ok(!/display:none|visibility:hidden(?!\})/.test(fit.replace('.snap-pt{position:absolute;left:0;width:1px;height:1px;pointer-events:none;visibility:hidden}', '')), 'the fit layer hides nothing');
});

t('fit layer changes no colours', () => {
  const body = fit.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/#[0-9a-f]{3,8}\b|rgba?\(|background|(^|[;{])color:|fill:|stroke:/i.test(body), 'no colour declarations');
});

t('home.js: snap points for every pinned chapter (hero, converge, film, 2D->3D, story, celebrations)', () => {
  for (const id of ['#heroVidWrap', '#converge', '#film', '#morph', '#story', '#solutions']) assert.ok(fitJs.includes("$('" + id + "')"), id);
  assert.match(fitJs, /\[0\.04, 0\.38, 0\.66, 0\.96\]/, 'morph snap points = its view buttons');
  assert.match(fitJs, /style\.setProperty\('top'/, 'CSSOM only (CSP)');
});

t('page content is untouched: same sections as live, notes board unchanged', () => {
  const ids = [...INDEX.matchAll(/<section [^>]*id="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids, ['problem', 'ways', 'converge', 'film', 'apps', 'morph', 'measure', 'story', 'crew', 'modules', 'repeat', 'client', 'why', 'compare', 'solutions', 'security', 'about', 'events', 'pricing', 'faq', 'contact']);
  assert.match(INDEX, /<div class="note y n1 rv" role="listitem">/);
  assert.match(INDEX, /Ravi thought Sita had it 🙃/);
  assert.match(INDEX, /<div class="unit rv" role="group" aria-label="Units">/);
});

t('version C: arrangement only - ways split out (no new text), tools row with buttons, modules four across', () => {
  assert.match(INDEX, /<section class="sec problem problem-ways" id="ways" aria-label="Four ways event work gets lost">\n <div class="wrap">\n  <div class="ways scraps-ways snap"/);
  const c = CSS.slice(CSS.indexOf('===== version C:'));
  assert.match(c, /\.mods\{grid-template-columns:repeat\(4,1fr\)\}/);
  assert.match(c, /\.flips\{display:flex;/);
  assert.match(JS, /b\.setAttribute\('aria-label', label\)/);
  assert.ok(!/\.note|\.vig|\.pin|\.hand/.test(c), 'notes and vignettes untouched');
});


t('r28 polish: section colours continuous (no body colour swap, edge blends), hero descender, crew, modules row, logo to top', () => {
  const r = CSS.slice(CSS.indexOf('r28 landing polish'));
  assert.match(r, /body\[data-tone=mint\],body\[data-tone=cream\]\{background:var\(--bg\)\}/);
  assert.match(r, /\.crew\{background-color:var\(--tone-mint\)\}/);
  assert.match(r, /\.pricing\{background-color:var\(--tone-cream\)\}/);
  assert.match(r, /\.modules\{background-image:linear-gradient\(180deg,var\(--tone-mint\)/);
  assert.match(r, /\.hl \.ln\{padding-bottom:\.2em;margin-bottom:-\.12em\}/);
  assert.match(r, /\.mods\{display:flex;[^}]*scroll-snap-type:x mandatory/);
  assert.match(r, /\.snap-pt\{scroll-snap-stop:normal\}/);
  assert.match(INDEX, /<div class="mods snap" id="modRow" role="region" tabindex="0" aria-label="Helm modules">/);
  assert.match(INDEX, /<\/div>\n   <div class="facts crew-facts">/, 'crew stats sit inside the crew flow, beside the phone');
  assert.match(JS, /rowNav\(modRow, 'modules'\)/);
  assert.match(JS, /a\.brand\[href="#top"\][\s\S]{0,400}window\.scrollTo\(\{ top: 0/);
  assert.match(JS, /clamp\(\(vh \* \.95 - \(r\.top \+ r\.height \/ 2\)\) \/ \(vh \* \.36\), 0, 1\)/, 'fill line completes before the centre');
});

console.log(`r27-landing-fit: ${passed} passed`);
