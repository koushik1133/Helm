// r21 landing photos: owner-supplied event photos as celebration-slider backgrounds + "Event ideas" gallery.
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const size = (p) => fs.statSync(new URL('../' + p, import.meta.url)).size;
let n = 0; const t = (name, fn) => { fn(); n++; console.log('  ok', name); };
const html = read('public/index.html'), css = read('public/home.css'), js = read('public/home.js');
const list = JSON.parse(read('public/landing/events/events.json'));
const NAMES = ['wedding', 'engagement', 'mehendi', 'sangeet', 'product-launch', 'corporate-gala', 'birthday', 'event-setup'];

t('every gallery image ships as 1600w + 800w WebP, within the weight budget', () => {
  let total = 0;
  for (const nm of NAMES) {
    const big = size(`public/landing/events/${nm}.webp`), small = size(`public/landing/events/${nm}-800.webp`);
    assert.ok(big < 320 * 1024, nm + ' 1600w too heavy: ' + big);
    assert.ok(small < 130 * 1024, nm + ' 800w too heavy: ' + small);
    total += big + small;
  }
  assert.ok(total < 3 * 1024 * 1024, 'total ' + total);
});

t('events.json lists all 8 with alt text, caption, type tag, local src + small copy', () => {
  assert.equal(list.length, 8);
  const LOCAL = /^\/landing\/events\/[A-Za-z0-9._-]+\.(webp|avif|jpe?g|png)$/i;
  list.forEach((p, i) => {
    assert.equal(p.src, `/landing/events/${NAMES[i]}.webp`);
    assert.equal(p.small, `/landing/events/${NAMES[i]}-800.webp`);
    assert.ok(LOCAL.test(p.src) && LOCAL.test(p.small));
    assert.ok(p.alt.length > 40 && p.alt.length <= 200, p.src);
    assert.ok(p.caption && p.caption.length <= 120 && p.type && p.type.length <= 30);
    assert.ok(p.width === 1600 && p.height > 800);
  });
});

t('gallery does not claim real client work: "Event ideas" heading', () => {
  assert.match(html, /<p class="eyebrow">Event ideas<\/p><h2 id="ev-h" class="h2">Plan events <em>like these\.<\/em><\/h2>/);
  assert.match(html, /<p class="lead">Weddings, launches and celebrations you can plan, quote and run in Helm\.<\/p>/);
  assert.doesNotMatch(html, /Illustrative images/);
  assert.doesNotMatch(html, /Events made <em>with Helm|Real events/);
  assert.match(js, /img\.srcset = it\.small \+ ' 800w, ' \+ it\.src \+ ' 1600w'/);
  assert.match(js, /bimg\.src = lite \? \(it\.small \|\| it\.src\) : \(\/\\\.avif\$\/i\.test\(shown\) \? shown : it\.src\)/);   // lightbox: full size, 800px only on Save-Data
  const evHtml = html.slice(html.indexOf('<!-- EVENTS FILM STRIP'), html.indexOf('<!-- VOICES'));
  const evJs = js.slice(js.indexOf('"Event ideas" film strip'));
  for (const [name, txt] of [['html', evHtml], ['js', evJs], ['README', read('public/landing/events/README.md')]]) assert.doesNotMatch(txt, /illustrat|\bAI\b/i, name);
});

t('film strip: full-width band, equal frames, seamless loop, pause, drag, keyboard, reduced motion, Save-Data', () => {
  assert.match(html, /<div class="reel" id="evReel" role="region" aria-roledescription="film strip" aria-label="Event images"><\/div>/);
  assert.doesNotMatch(html, /evGrid|ev-grid/);
  assert.doesNotMatch(css, /\.ev-grid\{|\.ev-item\{|columns:3 260px/);
  assert.match(css, /\.reel\{--fh:clamp\(140px,17vw,250px\);[^}]*overflow:hidden;overflow:clip\}/);   // strip clips inside its band
  assert.match(css, /\.reel \.ev-open\{[^}]*height:var\(--fh\);width:calc\(var\(--fh\) \* 1\.5\)/);   // every frame the same size
  assert.match(css, /\.reel \.ev-open img\{[^}]*object-fit:cover/);
  assert.match(css, /\.reel-set::before,\.reel-set::after\{/);   // sprocket holes per set = seamless
  assert.match(css, /\.reel-row\{[^}]*touch-action:pan-y/);
  assert.match(css, /\.reel\.moving \.reel-track\{will-change:transform\}/);
  assert.match(css, /\.reel\.still \.reel-row\{overflow-x:auto;[^}]*scroll-snap-type:x mandatory/);
  assert.match(js, /var lite = !!net\.saveData \|\| /);
  assert.match(js, /if \(lite\) img\.src = it\.small \|\| it\.src;/);
  assert.match(js, /var groups = \(!reduce && items\.length >= 6\)/);
  assert.match(js, /cp\.setAttribute\('aria-hidden', 'true'\)/);
  assert.match(js, /b\.tabIndex = -1;/);
  assert.match(js, /R\.track\.style\.transform = 'translate3d\('/);
  assert.match(js, /function running\(\) \{ return visible && !hover && !focus && !drag && !document\.hidden; \}/);
  assert.match(js, /if \(!reduce\) motion\(\);/);
  assert.match(js, /e\.key !== 'ArrowRight' && e\.key !== 'ArrowLeft'/);
  assert.match(js, /open\(i, items\[i\]\.btn\);/);
});

t('celebration slider: photo per slide, 800w/1600w srcset, lazy + current/next only, Save-Data keeps gradient', () => {
  assert.match(js, /var CEL_PHOTOS = \{ wedding: 'wedding', corporate: 'product-launch', birthday: 'birthday', concert: 'sangeet', gala: 'corporate-gala', cultural: 'mehendi' \};/);
  assert.match(js, /var celLite = !!celNet\.saveData \|\| /);
  assert.match(js, /\} else if \(CEL_PHOTOS\[name\] && !celLite\) \{/);
  assert.match(js, /bg\._im\.srcset = f \+ '-800\.webp 800w, ' \+ f \+ '\.webp 1600w';/);
  assert.match(js, /ph\.loading = 'lazy';/);
  assert.match(js, /celLoad\(bgs\[i\]\); celLoad\(bgs\[i \+ 1\]\);/);
  for (const ev of ['wedding', 'corporate', 'birthday', 'concert', 'gala', 'cultural']) assert.ok(html.includes(`data-ev="${ev}"`), ev);
  assert.match(css, /\.cel\.has-photos \.cel-scrim\{/);
  assert.match(css, /\.cel-bg\{[^}]*transition:opacity 1\.4s/);   // crossfade
});

console.log(`r21-landing-photos: ${n} passed`);
