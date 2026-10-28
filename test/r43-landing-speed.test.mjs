// R43 landing speed (version C): faster first screen, no jump on load, same design.
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('  ok', name); };
const html = read('public/index.html'), css = read('public/home.css'), js = read('public/home.js');

t('hero fonts + poster are preloaded from our own origin, matching the exact @font-face / poster URLs', () => {
  assert.match(html, /<link rel="preload" href="\/home-assets\/hero-poster\.webp" as="image" type="image\/webp" fetchpriority="high" media="\(min-width: 768px\)">/);   // wide screens only: on phones the hero text is the largest paint, so the poster must not crowd out the fonts
  for (const f of ['plus-jakarta-sans-latin', 'instrument-serif-latin-italic']) {
    assert.match(html, new RegExp(`<link rel="preload" href="/fonts/${f}\\.woff2\\?v=1" as="font" type="font/woff2" crossorigin>`));
    assert.match(css, new RegExp(`src:url\\(/fonts/${f}\\.woff2\\?v=1\\)`));
  }
  assert.ok(html.indexOf('rel="preload"') < html.indexOf('href="/home.css'), 'preloads come before the stylesheet');
  assert.doesNotMatch(html, /rel="preload"[^>]*href="https?:/, 'self-only preloads');
  assert.ok(fs.existsSync(new URL('../public/home-assets/hero-poster.webp', import.meta.url)));
  assert.match(html, /poster="\/home-assets\/hero-poster\.webp"/);
});

t('wide screens: sections below the first screen skip rendering again, with a placeholder of exactly one screen', () => {
  assert.doesNotMatch(css, /\.final,body>footer\{content-visibility:visible\}/);
  assert.match(css, /\.crew,\.modules,\.repeat,\.why,\.compare,\.security,\.about,\.voices,\.pricing,\.faq,\.contact,\.final\{contain-intrinsic-size:none calc\(100vh - var\(--navh\) - 2 \* var\(--fp\)\);contain-intrinsic-size:none calc\(100dvh - var\(--navh\) - 2 \* var\(--fp\)\)\}/);
  assert.match(css, /main>\.sec,main>\.fillsec,main>\.final\{min-height:100vh;min-height:100dvh;padding:calc\(var\(--navh\) \+ var\(--fp\)\) 0 var\(--fp\);/);   // the placeholder maths
  assert.match(css, / body>footer\{content-visibility:visible\}/);
});

t('no slide on load: the hero has a snap point in the markup, and new snap points go in before old ones come out', () => {
  assert.match(html, /<section class="hero" aria-labelledby="h1">\n <i class="snap-pt snap-top" aria-hidden="true"><\/i>/);
  assert.match(css, /\.snap-top\{top:0\}/);
  const b = js.slice(js.indexOf('  function build() {'), js.indexOf('  var t = 0;'));
  assert.ok(b.indexOf('var next = snapMq.matches ? plan() : [];') < b.indexOf('var old = made; made = [];'));
  assert.ok(b.indexOf('e[0].appendChild(i)') < b.indexOf('old.forEach(function (n) { if (n.parentNode) n.parentNode.removeChild(n); });'));
});

t('fit + snap set-up waits for the first paint; phones skip it; fitting batches reads and writes', () => {
  assert.match(js, /requestAnimationFrame\(function \(\) \{ setTimeout\(build, 0\); \}\);/);
  assert.doesNotMatch(js.slice(js.indexOf('function later()')), /\n  build\(\);\n/);
  assert.match(js, /if \(!fitMq\.matches && !zoomed\) return;/);
  assert.match(js, /var hs = open\.map\(function \(j\) \{ return contentH\(j\.kids\); \}\);   \/\/ reads only/);
  assert.match(js, /window\.addEventListener\('helm:relayout', later\);/);
});

t('film strip list is fetched after load, when idle (not during the first screen)', () => {
  assert.match(js, /var start = function \(\) \{ idle\(loadStrip, \{ timeout: 2000 \}\); \};/);
  assert.match(js, /if \(document\.readyState === 'complete'\) start\(\); else window\.addEventListener\('load', start, \{ once: true \}\);/);
  assert.match(js, /window\.dispatchEvent\(new Event\('helm:relayout'\)\);/);
  assert.equal((js.match(/function fill\(/g) || []).length, 1, 'no second function named fill in the strip scope');
});

t('phones: the hero intro text shows at once (rise only, no fade, no delay); wide screens keep the fade', () => {
  assert.match(css, /@keyframes riseup\{from\{transform:translateY\(18px\)\}\}/);
  assert.match(css, /@media \(max-width:767px\)\{\.lede\.up\{animation-name:riseup;animation-delay:0s\}\}/);
  assert.match(css, /\.lede\.up\{animation-delay:\.2s\}/);
  assert.match(css, /@keyframes fadeup\{from\{opacity:0;transform:translateY\(18px\)\}\}/);
});

t('in-page links: sections on the way render first, then a settle-and-correct pass (smooth unless reduced motion)', () => {
  const a = js.slice(js.indexOf('R43: in-page links land exactly on their section'));
  assert.ok(a.length > 500);
  assert.match(a, /if \(e\.defaultPrevented \|\| e\.button \|\| e\.metaKey \|\| e\.ctrlKey \|\| e\.shiftKey \|\| e\.altKey\) return;/);
  assert.match(a, /s\.style\.setProperty\('content-visibility', 'visible'\)/);
  assert.match(a, /s\.style\.removeProperty\('content-visibility'\)/);
  assert.match(a, /behavior: reduceMq\.matches \? 'auto' : 'smooth'/);
  assert.match(a, /pass\+\+ < 3/);
  assert.doesNotMatch(a, /preventDefault/);   // the browser's own anchor scroll, hash and focus stay as they were
  assert.match(a, /id === 'top' \|\| id === 'main'/);
});

t('cache-busters bumped', () => {
  assert.match(html, /\/home\.css\?v=38"/);
  assert.match(html, /\/home\.js\?v=38"/);
});
console.log(`r43-landing-speed: ${n} passed`);
