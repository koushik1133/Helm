// r21 landing 2: phones look finished at every width (converge, pinboard, pinned scenes, swipe dots,
// hidden client stories, self-hiding "Event ideas" gallery).
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('  ok', name); };

const html = read('public/index.html'), css = read('public/home.css'), js = read('public/home.js');

t('converge: phones get a compact static block with a "what one record holds" row; scroll fold-in only >= 768px', () => {
  assert.match(html, /<ul class="cv-folds" aria-label="What one Helm record holds">/);
  for (const w of ['Leads', 'Layouts', 'Quotes', 'Crew', 'Payments']) assert.ok(html.includes('</use></svg>' + w + '</li>') || html.includes('"/></svg>' + w + '</li>'), w);
  assert.match(css, /@media \(max-width:767px\)\{\s*\/\* 1\. converge[^\n]*\n \.apps\{height:auto\}\n \.apps-pin\{position:relative;height:auto;overflow:visible/);
  assert.match(css, /\.cv-folds,\.snap-dots\{display:none\}/);
  assert.match(js, /if \(apps && core && vw < 768\) \{/);
  assert.match(js, /cvSec\.classList\.add\('cv-in'\)/);
});

t('problem pinboard is a 2-column grid on phones (no sideways carousel, nothing clipped)', () => {
  assert.match(html, /<div class="board scraps" role="list"/);
  assert.doesNotMatch(html, /class="board scraps snap"/);
  assert.match(css, /\.problem \.board\{grid-template-columns:1fr 1fr;gap:20px 12px/);
});

t('pinned scenes never put headings under the nav: overflow starts at the top, anchors land on frame 1', () => {
  assert.match(css, /\.story-pin\{justify-content:flex-start\}\.story-pin>\.story-head\{margin-top:auto\}/);
  assert.match(css, /\.morph-pin\{align-items:flex-start\}\.morph-pin>\.morph-grid\{margin-block:auto\}/);
  assert.match(css, /#film,#morph,#solutions\{scroll-margin-top:calc\(-1 \* var\(--navh\) - 18px\)\}/);
  assert.match(css, /body:not\(\.mcta-off\) \.film-pin,body:not\(\.mcta-off\) \.story-pin,body:not\(\.mcta-off\) \.morph-pin\{padding-bottom:64px\}/);
});

t('swipe rows get decorative position dots (aria-hidden), built with DOM APIs', () => {
  assert.match(js, /dots\.className = 'snap-dots'; dots\.setAttribute\('aria-hidden', 'true'\);/);
  assert.match(css, /\.snap-dots i\.on\{width:20px;background:var\(--acc\)\}/);
});

t('client stories placeholder is hidden by one flag and not linked', () => {
  assert.match(html, /<section class="sec voices" aria-labelledby="v-h" hidden>/);
  assert.doesNotMatch(html, /href="#voices"/);
});

t('events gallery: hidden by default, filled only from /landing/events/events.json (own folder, alt required)', () => {
  assert.match(html, /<section class="sec gallery" id="events" aria-labelledby="ev-h" hidden>/);
  assert.match(js, /fetch\('\/landing\/events\/events\.json'/);
  assert.match(js, /var LOCAL = \/\^\\\/landing\\\/events\\\//);
  assert.match(js, /if \(!LOCAL\.test\(src\) \|\| !alt\) return null;/);
  assert.match(js, /img\.loading = 'lazy'/);
  assert.match(js, /sec\.hidden = false;/);
  assert.doesNotMatch(js.slice(js.indexOf('"Event ideas" photo gallery')), /innerHTML|insertAdjacentHTML/);
  assert.match(read('public/landing/events/README.md'), /1600 px wide/);
  assert.ok(read('.vercelignore').split('\n').includes('public/landing/events/README.md'));
});

console.log(`r21-landing2: ${n} passed`);
