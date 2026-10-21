// r26 speed: landing (/) + sign-in (/login) load faster without changing what they look like or do.
//  1. login.html: the app scripts are deferred (same order); config.js / telemetry.js stay normal scripts
//     (config.js may document.write config.staging.js); the page script runs at DOMContentLoaded (= after them).
//  2. Fonts are self-hosted (/fonts/, same files + unicode ranges Google Fonts served): no third-party
//     stylesheet before the first paint on /, /login or any page using public-v2.css.
//  3. Landing: fonts used only below the first screen (Caveat, upright Instrument Serif) load at the page
//     load event (home.js) - <noscript> keeps them for no-JS visitors.
//  4. Landing hero film card is in the page from the first paint (it is the largest thing on screen),
//     webp posters, smaller H.264 fallbacks (fast start), one-day cache for the film files.
import assert from 'node:assert/strict';
import { readFileSync, statSync, existsSync, openSync, readSync, closeSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log('  ✓ ' + name); };

const LOGIN = read('public/login.html'), INDEX = read('public/index.html');

t('login: app scripts deferred in the same order; config.js + telemetry.js stay normal scripts', () => {
  const order = ['event-name.js', 'country-profile.js', 'store-api.js', 'auth-ui.js', 'auth-visual.js', 'trial-facts.js', 'trial-signup.js', 'plan-cards.js', 'signup-flow.js'];
  let at = -1;
  for (const f of order) {
    const m = new RegExp('<script src="/?' + f.replace('.', '\\.') + '\\?v=\\d+"( defer)?></script>').exec(LOGIN);
    assert.ok(m, f + ' is loaded');
    assert.equal(m[1], ' defer', f + ' is deferred');
    assert.ok(m.index > at, f + ' keeps its place in the order'); at = m.index;
  }
  assert.match(LOGIN, /<script src="telemetry\.js\?v=\d+"><\/script>\n<script src="config\.js\?v=\d+"><\/script>/, 'config.js is not deferred (staging document.write)');
  assert.ok(LOGIN.indexOf('<script src="config.js') < LOGIN.indexOf('event-name.js'), 'config.js runs before the app scripts');
});

t('login: the page script runs at DOMContentLoaded (after the deferred scripts), wrapped whole', () => {
  const i = LOGIN.indexOf('<script>\ndocument.addEventListener("DOMContentLoaded", function(){\n  const $=(s)=>document.querySelector(s);');
  assert.ok(i > LOGIN.indexOf('signup-flow.js'), 'wrapper follows the last deferred script');
  const body = LOGIN.slice(i + '<script>'.length, LOGIN.indexOf('</script>', i));
  assert.match(body, /\n\}\);\n$/, 'wrapper closes at the end of the script');
  new Function(body);   // still parses
  // signup-flow.js reaches the page only through the hooks it is given (no globals from the page script)
  assert.match(read('public/signup-flow.js'), /hooks from login\.html: \{ showView, routeSignedIn, showErr, hoEnd \}/);
});

t('fonts: no Google Fonts stylesheet on /, /login or public-v2.css; every self-hosted file exists', () => {
  for (const [name, src] of [['index.html', INDEX], ['login.html', LOGIN], ['public-v2.css', read('public/public-v2.css')], ['home.css', read('public/home.css')]]) {
    assert.ok(!/fonts\.googleapis\.com|fonts\.gstatic\.com/.test(src), name + ' has no Google Fonts link');
  }
  const css = [read('public/home.css'), read('public/fonts/home-late.css'), read('public/public-v2.css'), LOGIN].join('\n');
  const urls = [...css.matchAll(/url\((\/fonts\/[a-z0-9-]+\.woff2)\?v=\d+\)/g)].map((m) => m[1]);
  assert.ok(urls.length >= 80, 'font faces found: ' + urls.length);
  for (const u of new Set(urls)) {
    assert.ok(existsSync(new URL('public' + u, root)), u + ' exists');
    const fd = openSync(new URL('public' + u, root)); const b = Buffer.alloc(4); readSync(fd, b, 0, 4, 0); closeSync(fd);
    assert.equal(b.toString('latin1'), 'wOF2', u + ' is woff2');
  }
  // same display behaviour as the Google stylesheets they replace
  assert.match(LOGIN, /font-family:'IBM Plex Sans';[^}]*font-display:optional/);
  assert.match(read('public/public-v2.css'), /font-family:'Plus Jakarta Sans';[^}]*font-display:swap/);
});

t('landing: below-the-fold fonts load after the page load event; no-JS copy in <noscript>', () => {
  const home = read('public/home.css'), late = read('public/fonts/home-late.css');
  assert.ok(!/'Caveat'/.test(home) && /'Caveat'/.test(late), 'Caveat only in home-late.css');
  assert.ok(!/'Instrument Serif';font-style:normal/.test(home), 'upright Instrument Serif only in home-late.css');
  assert.match(home, /'Instrument Serif';font-style:italic/, 'italic (used in the hero heading) stays in home.css');
  assert.match(late, /'Instrument Serif';font-style:normal/);
  const js = read('public/home.js');
  assert.match(js, /l\.href = '\/fonts\/home-late\.css\?v=\d+';[\s\S]{0,120}if \(document\.readyState === 'complete'\) add\(\); else window\.addEventListener\('load', add, \{ once: true \}\);/);
  assert.match(INDEX, /<noscript><link rel="stylesheet" href="\/fonts\/home-late\.css\?v=\d+"><\/noscript>\n<\/head>/);
});

t('landing hero: film card shown from the first paint (hidden only when there is no film); webp posters', () => {
  assert.match(INDEX, /<div class="hero-vid" id="heroVidWrap">/);
  assert.match(INDEX, /poster="\/home-assets\/hero-poster\.webp"/);
  const js = read('public/home.js');
  assert.match(js, /\} else if \(heroVidWrap\) \{\s*heroVidWrap\.hidden = true;/);
  assert.match(js, /'\/home-assets\/hero-hq-poster\.webp' : '\/home-assets\/hero-poster\.webp'/);
  // the card's first-paint size = the size home.js gives it on its first frame (no jump)
  assert.match(read('public/home.css'), /@media \(max-width:640px\)\{[\s\S]{0,200}\.hv-card\{width:100%;--s:\.9;/);
  assert.match(read('public/home.css'), /\.hv-prog\{[^}]*min-height:18px/);
  for (const p of ['hero-poster.webp', 'hero-hq-poster.webp']) {
    const fd = openSync(new URL('public/home-assets/' + p, root)); const b = Buffer.alloc(12); readSync(fd, b, 0, 12, 0); closeSync(fd);
    assert.equal(b.toString('latin1', 8, 12), 'WEBP', p);
  }
});

t('hero film files: H.264 fallbacks re-encoded small + fast start; VP9 webm unchanged', () => {
  const size = (p) => statSync(new URL('public/home-assets/' + p, root)).size;
  assert.ok(size('hero-hq.mp4') <= 5.2 * 1000 * 1000, 'hero-hq.mp4 is ' + size('hero-hq.mp4'));
  assert.ok(size('hero.mp4') <= 4 * 1000 * 1000, 'hero.mp4 is ' + size('hero.mp4'));
  assert.ok(size('hero-hq.webm') <= 4 * 1024 * 1024);
  for (const p of ['hero-hq.mp4', 'hero.mp4']) {
    const fd = openSync(new URL('public/home-assets/' + p, root)); const b = Buffer.alloc(65536); readSync(fd, b, 0, b.length, 0); closeSync(fd);
    const s = b.toString('latin1'), moov = s.indexOf('moov'), mdat = s.indexOf('mdat');
    assert.ok(moov > 0 && (mdat < 0 || moov < mdat), p + ': moov before mdat (plays while downloading)');
  }
});

t('caching: film + poster files cached for a day on Vercel', () => {
  const v = JSON.parse(read('vercel.json'));
  const rule = v.headers.find((r) => r.source === '/home-assets/(.*)\\.(mp4|webm|jpg)');
  assert.ok(rule, 'vercel.json media rule');
  assert.equal(rule.headers[0].value, 'public, max-age=86400, stale-while-revalidate=604800');
});

console.log(`r26-speed: ${passed} passed`);
